package com.andrewtinyakov.messenger.chat.service

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.testcontainers.containers.PostgreSQLContainer
import java.time.OffsetDateTime
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ChatActivityMigrationTests {
    @Test
    fun `backfill commits batches and preserves a concurrent send activity`() {
        PostgreSQLContainer<Nothing>("postgres:17-alpine").apply { start() }.use { postgres ->
            fun migration(target: String? = null) = Flyway.configure()
                .dataSource(postgres.jdbcUrl, postgres.username, postgres.password)
                .apply { if (target != null) target(target) }.load()
            migration("10").migrate()
            val source = org.postgresql.ds.PGSimpleDataSource().apply {
                setURL(postgres.jdbcUrl)
                user = postgres.username
                password = postgres.password
            }
            val db = JdbcTemplate(source)
            db.execute("INSERT INTO users(id,username,password_hash) VALUES ('owner','owner','x')")
            db.execute("INSERT INTO chats(id,kind,name) VALUES ('first','GROUP','First'), ('second','GROUP','Second')")
            db.execute("INSERT INTO chat_members(chat_id,user_id,joined_at) VALUES ('first','owner','2025-01-01Z')")
            assertNull(db.queryForObject("SELECT last_activity_at FROM chats WHERE id='first'", OffsetDateTime::class.java))
            assertEquals(
                OffsetDateTime.parse("2025-01-01T00:00:00Z"),
                db.queryForObject(
                    "SELECT coalesce(last_activity_at,joined_at) FROM chats JOIN chat_members ON chats.id=chat_id WHERE chats.id='first'",
                    OffsetDateTime::class.java,
                ),
            )
            db.execute(
                "INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at) " +
                    "SELECT lpad(i::text,26,'0'),CASE WHEN i<=5000 THEN 'first' ELSE 'second' END,i,'owner','old','2025-02-01Z' " +
                    "FROM generate_series(1,10000) i",
            )
            source.connection.use { sender ->
                sender.autoCommit = false
                sender.createStatement().execute("SELECT id FROM chats WHERE id='second' FOR UPDATE")
                val executor = Executors.newSingleThreadExecutor()
                try {
                    val backfill = executor.submit<Int> { migration().migrate().migrationsExecuted }
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (db.queryForObject(
                            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'CALL backfill_chat_activity%'",
                            Int::class.java,
                        ) == 0
                    ) {
                        check(System.nanoTime() < deadline) { "Backfill did not reach the locked second batch" }
                        Thread.sleep(20)
                    }
                    assertEquals(
                        OffsetDateTime.parse("2025-02-01T00:00:00Z"),
                        db.queryForObject("SELECT last_activity_at FROM chats WHERE id='first'", OffsetDateTime::class.java),
                    )
                    sender.createStatement().execute(
                        "INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at) " +
                            "VALUES ('new','second',10001,'owner','concurrent','2026-01-01Z')",
                    )
                    sender.createStatement().execute("UPDATE chats SET last_activity_at='2026-01-01Z' WHERE id='second'")
                    sender.commit()
                    assertEquals(1, backfill.get(30, TimeUnit.SECONDS))
                    assertEquals(
                        OffsetDateTime.parse("2026-01-01T00:00:00Z"),
                        db.queryForObject("SELECT last_activity_at FROM chats WHERE id='second'", OffsetDateTime::class.java),
                    )
                    assertEquals(0, migration().migrate().migrationsExecuted)
                } finally {
                    sender.rollback()
                    executor.shutdownNow()
                    assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
                }
            }
        }
    }
}
