package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.Meter
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.config.MeterFilter
import io.micrometer.core.instrument.config.MeterFilterReply
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.jooq.DSLContext
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
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
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import javax.sql.DataSource

class DatabaseObservationTests : MessengerIntegrationTest() {
    @Autowired private lateinit var users: UserRepository

    @Autowired private lateinit var messages: MessageRepository

    @Autowired private lateinit var tx: TransactionTemplate

    @Autowired private lateinit var metrics: MeterRegistry

    @Autowired private lateinit var sql: DSLContext

    @Autowired private lateinit var dataSource: DataSource

    @Test
    fun `boot listeners measure committed rolled back and participating transactions`() {
        val name = "observe-${newId()}"
        val rollbackName = "rollback-${newId()}"
        val committedBefore = count("messenger.database.transaction", "auth.register", "committed")
        val rolledBackBefore = count("messenger.database.transaction", "auth.register", "rolled_back")
        val joinedBefore = count("messenger.database.transaction", "auth.logout", "committed")
        val queriesBefore = count("messenger.database.query", "user.insert_user", "success")
        tx.observedExecute(DatabaseTransaction.AUTH_REGISTER) {
            users.insertUser(User(UserId(newId()), name, "hash"))
            tx.observedExecute(DatabaseTransaction.AUTH_LOGOUT) { users.findUserByUsername(name) }
        }
        assertNotNull(users.findUserByUsername(name))
        assertThrows(IllegalArgumentException::class.java) {
            tx.observedExecute(DatabaseTransaction.AUTH_REGISTER) {
                users.insertUser(User(UserId(newId()), rollbackName, "hash"))
                throw IllegalArgumentException("rollback")
            }
        }
        assertNull(users.findUserByUsername(rollbackName))
        assertEquals(committedBefore + 1, count("messenger.database.transaction", "auth.register", "committed"))
        assertEquals(rolledBackBefore + 1, count("messenger.database.transaction", "auth.register", "rolled_back"))
        assertEquals(joinedBefore, count("messenger.database.transaction", "auth.logout", "committed"))
        assertEquals(queriesBefore + 2, count("messenger.database.query", "user.insert_user", "success"))
        for (phase in listOf("begin", "active", "commit", "rollback")) {
            assertTrue(
                metrics.get("messenger.database.transaction.phase").tags("operation", "auth.register", "phase", phase).timers().sumOf {
                    it.count()
                } >
                    0,
            )
        }
    }

    @Test
    fun `sql failure retains exception translation and records exactly once`() {
        val name = "duplicate-${newId()}"
        users.insertUser(User(UserId(newId()), name, "hash"))
        val before = count("messenger.database.query", "user.insert_user", "failure")
        val statements = count("messenger.database.statement", "user.insert_user", "failure")
        assertThrows(DuplicateKeyException::class.java) { users.insertUser(User(UserId(newId()), name, "secret-hash")) }
        assertEquals(before + 1, count("messenger.database.query", "user.insert_user", "failure"))
        assertEquals(statements + 1, count("messenger.database.statement", "user.insert_user", "failure"))
        assertTrue(metrics.meters.none { meter -> meter.id.tags.any { it.value.contains(name) || it.value.contains("secret-hash") } })
    }

    @Test
    fun `routine and batch executions keep attribution`() {
        val before = count("messenger.database.query", "message.lock_send", "success")
        tx.observedExecute(DatabaseTransaction.SEND_SINGLE) { messages.lockSend(UserId(newId()), RequestId(newId())) }
        assertEquals(before + 1, count("messenger.database.query", "message.lock_send", "success"))
        val batchBefore = count("messenger.database.statement", "other", "success")
        assertEquals(
            listOf(0, 0),
            sql.batch(
                sql.query("update users set username = username where false"),
                sql.query("update users set username = username where false"),
            ).execute().toList(),
        )
        assertTrue(count("messenger.database.statement", "other", "success") > batchBefore)
    }

    @Test
    fun `nested scopes restore attribution after exceptions and across threads`() {
        val before = count("messenger.database.query", "user.search", "success")
        val pool = Executors.newFixedThreadPool(2)
        try {
            val tasks = listOf(DatabaseOperation.USER_SEARCH, DatabaseOperation.USER_FIND_SUMMARY).map { operation ->
                Callable {
                    repeat(5) {
                        DatabaseObservation.query(operation) {
                            assertThrows(IllegalStateException::class.java) {
                                DatabaseObservation.query(DatabaseOperation.USER_INSERT_USER) { error("restore") }
                            }
                            sql.selectOne().fetch()
                        }
                    }
                }
            }
            pool.invokeAll(tasks).forEach { it.get() }
        } finally {
            pool.shutdownNow()
        }
        assertEquals(before + 5, count("messenger.database.query", "user.search", "success"))
        val unattributed = count("messenger.database.query", "other", "success")
        sql.selectOne().fetch()
        assertEquals(unattributed + 1, count("messenger.database.query", "other", "success"))
    }

    @Test
    fun `recording failure cannot change committed data or replace sql failure`() {
        SimpleMeterRegistry().let { broken ->
            broken.config().meterFilter(object : MeterFilter {
                override fun accept(id: Meter.Id): MeterFilterReply {
                    if (id.name != "messenger.database.instrumentation.failures") error("recorder unavailable")
                    return MeterFilterReply.NEUTRAL
                }
            })
            val recorder = DatabaseMetrics(broken)
            val manager = JdbcTransactionManager(dataSource).apply { addListener(DatabaseTransactionListener(recorder)) }
            val observedSql = DSL.using(
                DefaultConfiguration().set(SQLDialect.POSTGRES).set(dataSource).set(DatabaseQueryListener(recorder)),
            )
            val name = "recorder-${newId()}"
            TransactionTemplate(manager).observedExecute(DatabaseTransaction.AUTH_REGISTER) {
                observedSql.execute("insert into users(id,username,password_hash) values (?,?,?)", newId(), name, "hash")
            }
            assertNotNull(users.findUserByUsername(name))
            assertThrows(org.jooq.exception.DataAccessException::class.java) {
                observedSql.execute("select * from missing_observation_table")
            }
            assertTrue(broken.get("messenger.database.instrumentation.failures").gauge().value() > 0)
        }
    }

    @Test
    fun `rollback only returns callback result without reporting commit`() {
        val name = "rollback-only-${newId()}"
        val before = count("messenger.database.transaction", "send.single", "rolled_back")
        assertEquals(
            "callback-result",
            tx.observedExecute(DatabaseTransaction.SEND_SINGLE) {
                users.insertUser(User(UserId(newId()), name, "hash"))
                it.setRollbackOnly()
                "callback-result"
            },
        )
        assertNull(users.findUserByUsername(name))
        assertEquals(before + 1, count("messenger.database.transaction", "send.single", "rolled_back"))
    }

    @Test
    fun `fetch failures close the lifecycle once without changing statement success`() {
        val before = count("messenger.database.query", "other", "failure")
        val statements = count("messenger.database.statement", "other", "success")
        val failingFetch = sql.configuration().deriveAppending(object : ExecuteListener {
            override fun fetchStart(ctx: ExecuteContext) {
                throw IllegalArgumentException("controlled fetch failure")
            }
        })
        assertThrows(IllegalArgumentException::class.java) { DSL.using(failingFetch).selectOne().fetch() }
        assertEquals(before + 1, count("messenger.database.query", "other", "failure"))
        assertEquals(statements + 1, count("messenger.database.statement", "other", "success"))
        assertTrue(count("messenger.database.fetch", "other", "failure") > 0)
    }

    @Test
    fun `advisory lock contention appears in the named statement timing`() {
        val sender = UserId(newId())
        val request = RequestId(newId())
        val locked = CountDownLatch(1)
        val release = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val holder = pool.submit {
                tx.observedExecute(DatabaseTransaction.SEND_SINGLE) {
                    messages.lockSend(sender, request)
                    locked.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                }
            }
            assertTrue(locked.await(5, TimeUnit.SECONDS))
            val waiting = pool.submit { tx.observedExecute(DatabaseTransaction.SEND_SINGLE) { messages.lockSend(sender, request) } }
            assertThrows(TimeoutException::class.java) { waiting.get(150, TimeUnit.MILLISECONDS) }
            release.countDown()
            holder.get(5, TimeUnit.SECONDS)
            waiting.get(5, TimeUnit.SECONDS)
            assertTrue(
                metrics.get(
                    "messenger.database.statement",
                ).tags("operation", "message.lock_send", "outcome", "success").timer().max(TimeUnit.MILLISECONDS) >=
                    100,
            )
        } finally {
            release.countDown()
            pool.shutdownNow()
            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    private fun count(name: String, operation: String, outcome: String): Long =
        metrics.find(name).tags("operation", operation, "outcome", outcome).timer()?.count() ?: 0
}
