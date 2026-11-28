package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.postgresFunction
import org.flywaydb.core.Flyway
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.testcontainers.containers.PostgreSQLContainer
import java.time.OffsetDateTime
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ChatActivityMigrationTests {
    @Test
    fun `backfill commits batches and preserves a concurrent send activity`() {
        PostgreSQLContainer<Nothing>("postgres:19-alpine").apply { start() }.use { postgres ->
            fun migration(target: String? = null) = Flyway.configure()
                .dataSource(postgres.jdbcUrl, postgres.username, postgres.password)
                .apply { if (target != null) target(target) }.load()
            migration("10").migrate()
            val source = PGSimpleDataSource().apply {
                setURL(postgres.jdbcUrl)
                user = postgres.username
                password = postgres.password
            }
            val db = DSL.using(source, SQLDialect.POSTGRES)
            val joinedAt = OffsetDateTime.parse("2025-01-01T00:00:00Z")
            val oldActivity = OffsetDateTime.parse("2025-02-01T00:00:00Z")
            val newActivity = OffsetDateTime.parse("2026-01-01T00:00:00Z")
            db.insertInto(USERS, USERS.ID, USERS.USERNAME, USERS.PASSWORD_HASH).values("owner", "owner", "x").execute()
            db.insertInto(CHATS, CHATS.ID, CHATS.KIND, CHATS.NAME)
                .values("first", ChatKind.GROUP, "First")
                .values("second", ChatKind.GROUP, "Second").execute()
            db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID, CHAT_MEMBERS.JOINED_AT)
                .values("first", "owner", joinedAt).execute()

            fun activity(chatId: String) = db.select(CHATS.LAST_ACTIVITY_AT).from(CHATS)
                .where(CHATS.ID.eq(chatId)).fetchSingle().value1()?.toInstant()

            assertNull(activity("first"))
            assertEquals(
                joinedAt.toInstant(),
                db.select(DSL.coalesce(CHATS.LAST_ACTIVITY_AT, CHAT_MEMBERS.JOINED_AT)).from(CHATS)
                    .join(CHAT_MEMBERS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
                    .where(CHATS.ID.eq("first")).fetchSingle().value1().toInstant(),
            )
            val series = DSL.generateSeries(1, 10000).`as`("series", "sequence")
            val sequence = series.field(0, SQLDataType.BIGINT)!!
            db.insertInto(
                MESSAGES,
                MESSAGES.ID,
                MESSAGES.CHAT_ID,
                MESSAGES.SEQUENCE,
                MESSAGES.SENDER_ID,
                MESSAGES.BODY,
                MESSAGES.CREATED_AT,
            )
                .select(
                    db.select(
                        DSL.lpad(sequence.cast(SQLDataType.VARCHAR), 26, "0"),
                        DSL.`when`(sequence.le(5000L), "first").otherwise("second"),
                        sequence,
                        DSL.inline("owner"),
                        DSL.inline("old"),
                        DSL.inline(oldActivity),
                    ).from(series),
                ).execute()
            source.connection.use { sender ->
                sender.autoCommit = false
                val senderDb = DSL.using(sender, SQLDialect.POSTGRES)
                senderDb.select(CHATS.ID).from(CHATS).where(CHATS.ID.eq("second")).forUpdate().fetchSingle()
                val senderPid = senderDb.fetchValue(postgresFunction("pg_backend_pid", SQLDataType.INTEGER))!!
                val statActivity = DSL.table(DSL.name("pg_catalog", "pg_stat_activity"))
                val query = DSL.field(DSL.name("query"), SQLDataType.VARCHAR)
                val pid = DSL.field(DSL.name("pid"), SQLDataType.INTEGER)
                val blockers = postgresFunction("pg_blocking_pids", SQLDataType.INTEGER.arrayDataType, pid)
                val executor = Executors.newSingleThreadExecutor()
                try {
                    val backfill = executor.submit<Int> { migration("11").migrate().migrationsExecuted }
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (!db.fetchExists(
                            statActivity,
                            query.contains("backfill_chat_activity"),
                            DSL.inline(senderPid).eq(DSL.any(blockers)),
                        )
                    ) {
                        check(System.nanoTime() < deadline) { "Backfill did not reach the locked second batch" }
                        Thread.sleep(20)
                    }
                    assertEquals(oldActivity.toInstant(), activity("first"))
                    senderDb.insertInto(
                        MESSAGES,
                        MESSAGES.ID,
                        MESSAGES.CHAT_ID,
                        MESSAGES.SEQUENCE,
                        MESSAGES.SENDER_ID,
                        MESSAGES.BODY,
                        MESSAGES.CREATED_AT,
                    ).values("new", "second", 10001L, "owner", "concurrent", newActivity).execute()
                    senderDb.update(CHATS).set(CHATS.LAST_ACTIVITY_AT, newActivity).where(CHATS.ID.eq("second")).execute()
                    sender.commit()
                    assertEquals(1, backfill.get(30, TimeUnit.SECONDS))
                    assertEquals(newActivity.toInstant(), activity("second"))
                    assertEquals(0, migration("11").migrate().migrationsExecuted)
                } finally {
                    sender.rollback()
                    executor.shutdownNow()
                    assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
                }
            }
        }
    }
}
