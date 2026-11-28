package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.ApiApplication
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType.BOOLEAN
import org.jooq.impl.SQLDataType.INTEGER
import org.jooq.impl.SQLDataType.OTHER
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.containers.wait.strategy.Wait
import org.testcontainers.images.builder.Transferable
import java.sql.DriverManager
import java.time.Duration

@SpringBootTest(
    classes = [ApiApplication::class],
    properties = [
        "messenger.grpc.enabled=false",
        "spring.rabbitmq.dynamic=false",
        "spring.rabbitmq.listener.simple.auto-startup=false",
        "messenger.database.replica.max-lag=64KB",
        "messenger.database.replica.check-interval=1h",
    ],
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ReplicaReadsTests {
    @Autowired private lateinit var reads: ReadTransactions

    @Autowired private lateinit var lag: ReplicaLagMonitor

    @Autowired private lateinit var tx: TransactionTemplate

    @Autowired private lateinit var sql: DSLContext

    private val probeTable = DSL.table(DSL.name("replica_probe"))
    private val probeId = DSL.field(DSL.name("id"), INTEGER)

    @BeforeEach
    fun createTable() {
        tx.execute { sql.createTableIfNotExists(probeTable).column(probeId).constraints(DSL.primaryKey(probeId)).execute() }
        awaitHealthy()
    }

    @AfterEach
    fun resumeReplay() {
        replicaAdmin("select pg_wal_replay_resume()")
    }

    @Test
    fun `replica reads run on the standby and primary reads on the primary`() {
        assertEquals(true, reads.replica(snapshot = true) { recovering() })
        assertEquals(false, reads.primary { recovering() })
    }

    @Test
    fun `a stale replica result falls back to the primary`() {
        replicaAdmin("select pg_wal_replay_pause()")
        tx.execute { sql.insertInto(probeTable, probeId).values(1).execute() }

        val fromReplica = reads.replica { probe(1).takeIf { it } }
        val result = fromReplica ?: reads.primary { probe(1) }

        assertNull(fromReplica)
        assertTrue(result)
    }

    @Test
    fun `a lagging replica is skipped without a query`() {
        replicaAdmin("select pg_wal_replay_pause()")
        val series = DSL.generateSeries(10, 5000).`as`("g", "id")
        tx.execute {
            sql.insertInto(probeTable, probeId).select(sql.select(series.field(0, INTEGER)!!).from(series)).execute()
        }
        lag.check()

        assertFalse(lag.healthy)
        assertNull(reads.replica { recovering() })
    }

    private fun recovering(): Boolean = sql.fetchValue(postgresFunction("pg_is_in_recovery", BOOLEAN))!!

    private fun probe(id: Int): Boolean = sql.fetchExists(sql.selectOne().from(probeTable).where(probeId.eq(id)))

    private fun awaitHealthy() {
        val tableExists = DSL.field(postgresFunction("to_regclass", OTHER, DSL.`val`(probeTable.name)).isNotNull)
        val deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos()
        while (true) {
            lag.check()
            if (lag.healthy && reads.replica { sql.fetchValue(tableExists) } == true) {
                return
            }
            check(System.nanoTime() < deadline) { "Replica did not catch up" }
            Thread.sleep(100)
        }
    }

    private fun replicaAdmin(statement: String) {
        DriverManager.getConnection(replicaUrl(), USER, PASSWORD).use { it.createStatement().use { s -> s.execute(statement) } }
    }

    companion object {
        private const val USER = "messenger"
        private const val PASSWORD = "messenger"
        private val primary = PostgreSQLContainer<Nothing>("postgres:17-alpine").apply {
            withDatabaseName("messenger")
            withUsername(USER)
            withPassword(PASSWORD)
            withCommand("postgres", "-c", "wal_level=replica", "-c", "max_wal_senders=4", "-c", "fsync=off")
            withCopyToContainer(
                Transferable.of("echo 'host replication all all trust' >> \"\$PGDATA/pg_hba.conf\"\n"),
                "/docker-entrypoint-initdb.d/replication.sh",
            )
            start()
        }

        private val replica = GenericContainer<Nothing>("postgres:17-alpine").apply {
            withExposedPorts(5432)
            withEnv("PGPASSWORD", PASSWORD)
            val script =
                """
                set -e
                install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/replica
                gosu postgres pg_basebackup -d 'host=${primaryAddress()} user=$USER application_name=replica' -D /var/lib/postgresql/replica -R -X stream
                exec gosu postgres postgres -D /var/lib/postgresql/replica -c hot_standby=on -c listen_addresses='*'
                """.trimIndent()
            withCreateContainerCmdModifier { it.withEntrypoint("sh", "-c", script) }
            waitingFor(Wait.forLogMessage(".*ready to accept read-only connections.*", 1).withStartupTimeout(Duration.ofMinutes(2)))
            dependsOn(primary)
            start()
        }

        private fun primaryAddress(): String = primary.containerInfo.networkSettings.networks.values.first().ipAddress!!

        private fun replicaUrl() = "jdbc:postgresql://${replica.host}:${replica.getMappedPort(5432)}/messenger"

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", primary::getJdbcUrl)
            registry.add("spring.datasource.username", primary::getUsername)
            registry.add("spring.datasource.password", primary::getPassword)
            registry.add("messenger.database.replica.url", ::replicaUrl)
        }
    }
}
