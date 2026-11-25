package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.ApiApplication
import org.jooq.DSLContext
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

    @BeforeEach
    fun createTable() {
        tx.execute { sql.execute("create table if not exists replica_probe(id int primary key)") }
        awaitHealthy()
    }

    @AfterEach
    fun resumeReplay() {
        replicaAdmin("select pg_wal_replay_resume()")
    }

    @Test
    fun `replica reads run on the standby and primary reads on the primary`() {
        assertEquals(true, reads.replica { recovering() })
        assertEquals(false, reads.primary { recovering() })
    }

    @Test
    fun `a stale replica result falls back to the primary`() {
        replicaAdmin("select pg_wal_replay_pause()")
        tx.execute { sql.execute("insert into replica_probe values (1)") }

        val fromReplica = reads.replica { probe(1).takeIf { it } }
        val result = fromReplica ?: reads.primary { probe(1) }

        assertNull(fromReplica)
        assertTrue(result)
    }

    @Test
    fun `a lagging replica is skipped without a query`() {
        replicaAdmin("select pg_wal_replay_pause()")
        tx.execute { sql.execute("insert into replica_probe select g from generate_series(10, 5000) g") }
        lag.check()

        assertFalse(lag.healthy)
        assertNull(reads.replica { recovering() })
    }

    private fun recovering(): Boolean = sql.resultQuery("select pg_is_in_recovery()").fetchOne(0, Boolean::class.java)!!

    private fun probe(id: Int): Boolean = sql.resultQuery(
        "select exists(select 1 from replica_probe where id = ?)",
        id,
    ).fetchOne(0, Boolean::class.java)!!

    private fun awaitHealthy() {
        val deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos()
        while (true) {
            lag.check()
            if (lag.healthy &&
                reads.replica { sql.resultQuery("select to_regclass('replica_probe') is not null").fetchOne(0, Boolean::class.java) } ==
                true
            ) {
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
