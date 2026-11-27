package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.infrastructure.database.monitoring.DatabaseMetrics
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.Meter
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.config.MeterFilter
import io.micrometer.core.instrument.config.MeterFilterReply
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.jooq.DSLContext
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.jooq.impl.DefaultConfiguration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.dao.DuplicateKeyException
import org.springframework.jdbc.support.JdbcTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import javax.sql.DataSource

class DatabaseObservationTests : MessengerIntegrationTest() {
    @Autowired private lateinit var users: UserRepository

    @Autowired private lateinit var tx: TransactionTemplate

    @Autowired private lateinit var metrics: MeterRegistry

    @Autowired private lateinit var entryPoints: EntryPointResolver

    @Autowired private lateinit var sql: DSLContext

    @Autowired private lateinit var dataSource: DataSource

    @Test
    fun `every statement starts with a sqlcommenter tag for the current entry point`() {
        val tag = "/*application='messenger-api',thread='sessions-cleanup'*/ "
        val padding = "x".repeat(1100)
        var activity: String? = null
        var batched: List<String> = emptyList()
        Thread({
            activity = sql.resultQuery("select query from pg_stat_activity where pid = pg_backend_pid() and '$padding' <> ''")
                .fetchOne(0, String::class.java)
            batched = tx.execute {
                sql.execute("create temporary table seen_statements(statement text) on commit drop")
                sql.batch(
                    sql.query("insert into seen_statements select current_query() where '-- not a comment' <> ''"),
                    sql.query("insert into seen_statements select current_query() where '/* not a comment */' <> ''"),
                ).execute()
                sql.resultQuery("select statement from seen_statements").fetch(0, String::class.java)
            }!!
        }, "sessions-cleanup-3").apply {
            start()
            join()
        }
        assertTrue(activity!!.startsWith(tag), activity)
        assertEquals(2, batched.size)
        assertTrue(
            batched.all {
                it.startsWith(tag) && it.indexOf("/*application=") == it.lastIndexOf("/*application=")
            },
            batched.toString(),
        )
    }

    @Test
    fun `transactions and queries are timed by entry point without per call names`() {
        val entryPoint = entryPoints.current()
        val name = "observe-${newId()}"
        val rollbackName = "rollback-${newId()}"
        val committedBefore = count("messenger.database.transaction", entryPoint, "committed")
        val rolledBackBefore = count("messenger.database.transaction", entryPoint, "rolled_back")
        val queriesBefore = count("messenger.database.query", entryPoint, "success")
        tx.execute {
            users.insertUser(User(UserId(newId()), name, "hash"))
            tx.execute { users.findUserByUsername(name) }
        }
        assertNotNull(users.findUserByUsername(name))
        assertThrows(IllegalArgumentException::class.java) {
            tx.execute {
                users.insertUser(User(UserId(newId()), rollbackName, "hash"))
                throw IllegalArgumentException("rollback")
            }
        }
        assertNull(users.findUserByUsername(rollbackName))
        assertEquals(committedBefore + 1, count("messenger.database.transaction", entryPoint, "committed"))
        assertEquals(rolledBackBefore + 1, count("messenger.database.transaction", entryPoint, "rolled_back"))
        assertTrue(count("messenger.database.query", entryPoint, "success") >= queriesBefore + 4)
        for (phase in listOf("begin", "active", "commit", "rollback")) {
            val timers = metrics.get("messenger.database.transaction.phase").tags("entrypoint", entryPoint.name, "phase", phase).timers()
            assertTrue(timers.sumOf { it.count() } > 0, phase)
        }
    }

    @Test
    fun `sql failure keeps exception translation and records once without request data`() {
        val entryPoint = entryPoints.current()
        val name = "duplicate-${newId()}"
        users.insertUser(User(UserId(newId()), name, "hash"))
        val before = count("messenger.database.query", entryPoint, "failure")
        assertThrows(DuplicateKeyException::class.java) { users.insertUser(User(UserId(newId()), name, "secret-hash")) }
        assertEquals(before + 1, count("messenger.database.query", entryPoint, "failure"))
        assertTrue(metrics.meters.none { meter -> meter.id.tags.any { it.value.contains(name) || it.value.contains("secret-hash") } })
    }

    @Test
    fun `rollback only returns callback result without reporting commit`() {
        val entryPoint = entryPoints.current()
        val name = "rollback-only-${newId()}"
        val before = count("messenger.database.transaction", entryPoint, "rolled_back")
        val result = tx.execute {
            users.insertUser(User(UserId(newId()), name, "hash"))
            it.setRollbackOnly()
            "callback-result"
        }
        assertEquals("callback-result", result)
        assertNull(users.findUserByUsername(name))
        assertEquals(before + 1, count("messenger.database.transaction", entryPoint, "rolled_back"))
    }

    @Test
    fun `recording failure cannot change committed data or replace sql failure`() {
        val broken = SimpleMeterRegistry()
        broken.config().meterFilter(object : MeterFilter {
            override fun accept(id: Meter.Id): MeterFilterReply {
                if (id.name != "messenger.database.instrumentation.failures") error("recorder unavailable")
                return MeterFilterReply.NEUTRAL
            }
        })
        val recorder = DatabaseMetrics(broken)
        val manager = JdbcTransactionManager(dataSource).apply { addListener(DatabaseTransactionListener(recorder, entryPoints)) }
        val listener = DatabaseQueryListener(recorder, entryPoints, SqlComment("messenger-api"))
        val observedSql = DSL.using(DefaultConfiguration().set(SQLDialect.POSTGRES).set(dataSource).set(listener))
        val name = "recorder-${newId()}"
        TransactionTemplate(manager).execute {
            observedSql.execute("insert into users(id,username,password_hash) values (?,?,?)", newId(), name, "hash")
        }
        assertNotNull(users.findUserByUsername(name))
        assertThrows(org.jooq.exception.DataAccessException::class.java) { observedSql.execute("select * from missing_observation_table") }
        assertTrue(broken.get("messenger.database.instrumentation.failures").gauge().value() > 0)
    }

    private fun count(name: String, entryPoint: EntryPoint, outcome: String): Long =
        metrics.find(name).tags("entrypoint_kind", entryPoint.kind, "entrypoint", entryPoint.name, "outcome", outcome).timer()?.count() ?: 0
}
