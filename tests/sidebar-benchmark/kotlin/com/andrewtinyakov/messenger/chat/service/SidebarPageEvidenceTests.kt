package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.directory.JooqChatDirectoryRepository
import com.andrewtinyakov.messenger.infrastructure.database.PostgresExplain
import com.andrewtinyakov.messenger.infrastructure.database.PostgresExplainFormat
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.Query
import org.jooq.SQLDialect
import org.jooq.conf.ParamType
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import tools.jackson.databind.json.JsonMapper
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import kotlin.math.ceil
import kotlin.system.measureNanoTime

@EnabledIfEnvironmentVariable(named = "SIDEBAR_BENCH_DB_URL", matches = ".+")
class SidebarPageEvidenceTests {
    @Test
    fun `measure the emitted page query against the isolated seeded database`() {
        val url = System.getenv("SIDEBAR_BENCH_DB_URL")
        require(url.startsWith("jdbc:postgresql://localhost:25457/"))
        DriverManager.getConnection(url, "messenger", "messenger").use { connection ->
            val statements = mutableListOf<Pair<Query, String>>()
            val listener =
                object : ExecuteListener {
                    override fun executeStart(ctx: ExecuteContext) {
                        ctx.query()?.let { statements.add(it to it.getSQL(ParamType.INLINED)) }
                    }
                }
            val db = DSL.using(connection, SQLDialect.POSTGRES)
            val serverVersion = connection.metaData.databaseProductVersion
            val repository = JooqChatDirectoryRepository(DSL.using(db.configuration().derive(listener)))
            val viewer = UserId("00000000000000000000000001")

            fun page() {
                val chats = repository.findByMember(viewer, null, null, 101)
                assertEquals(101, chats.size)
                repository.findMembersByChatIds(chats.take(100).filter { it.chat.kind == ChatKind.DIRECT }.map { it.chat.id })
            }
            page()
            val (query, sql) = statements.first { (_, rendered) -> rendered.contains("summary_candidates") }
            val explain = PostgresExplain(connection)
            statements.clear()
            repeat(5) { page() }
            val wall = List(60) { measureNanoTime { page() } / 1_000_000.0 }.sorted()
            val mapper = JsonMapper.builder().build()
            val execution =
                List(60) {
                    val json = explain.analyze(query, PostgresExplainFormat.JSON).single()
                    mapper
                        .readTree(json)
                        .get(0)
                        .path("Execution Time")
                        .asDouble()
                }.sorted()

            fun percentile(
                values: List<Double>,
                p: Double,
            ) = values[ceil(values.size * p).toInt() - 1]
            val directory = Path.of("../../docs/evidence")
            Files.createDirectories(directory)
            Files.writeString(Path.of("../../tests/sidebar-benchmark/sidebar-page.sql"), sql + ";\n")
            val plan = explain.analyze(query, PostgresExplainFormat.TEXT).joinToString("\n")
            Files.writeString(directory.resolve("sidebar-page-plan.txt"), plan + "\n")
            statements.clear()
            val largeChat = ChatId("00000000000000000010000000")
            val large = repository.findMemberDetails(largeChat, viewer)!!
            val (largeQuery) = statements.last { (_, rendered) -> rendered.contains("summary_candidates") }
            val largePlan = explain.analyze(largeQuery, PostgresExplainFormat.TEXT).joinToString("\n")
            Files.writeString(directory.resolve("sidebar-large-chat-plan.txt"), largePlan + "\n")
            val counts =
                db
                    .select(
                        DSL
                            .select(
                                DSL.countLarge(),
                            ).from(MESSAGES)
                            .where(MESSAGES.CHAT_ID.eq(largeChat.value))
                            .asField<Long>("large_chat_messages"),
                        DSL
                            .select(DSL.countLarge())
                            .from(CHAT_MEMBERS)
                            .where(CHAT_MEMBERS.USER_ID.eq(viewer.value))
                            .asField<Long>("viewer_chats"),
                        DSL.select(DSL.countLarge()).from(HIDDEN_MESSAGE_RANGES).asField<Long>("exclusions"),
                    ).fetchSingle()
            val exactUnread =
                db
                    .select(DSL.countLarge())
                    .from(MESSAGES)
                    .where(
                        MESSAGES.CHAT_ID.eq(largeChat.value),
                        MESSAGES.SEQUENCE.gt(1_000_000L),
                        MESSAGES.SENDER_ID.ne(viewer.value),
                        MESSAGES.SEQUENCE.mod(10L).notBetween(1L, 5L),
                    ).fetchSingle()
                    .value1()
            Files.writeString(
                directory.resolve("sidebar-window-result.txt"),
                listOf(
                    "Window unreadCount=${large.chat.unreadCount}, capped=${large.chat.unreadCountCapped}",
                    "Seed-derived exact unread=$exactUnread",
                    "Last message sequence=${large.chat.lastMessage?.sequence}",
                    "Sender username=${large.chat.lastMessage?.senderUsername}",
                ).joinToString("\n", postfix = "\n"),
            )
            Files.writeString(
                directory.resolve("sidebar-page-measurements.txt"),
                listOf(
                    "PostgreSQL $serverVersion, isolated compose database, 2 CPU quota, 768 MiB limit.",
                    "Dataset: $counts",
                    "Warmup: 5 pages. Samples: 60 each, serial, warm cache. Page size: 100 plus one lookahead.",
                    "Repository page plus direct member preview wall clock:",
                    "p50=${percentile(wall, 0.50)} ms p95=${percentile(wall, 0.95)} ms",
                    "PostgreSQL main page execution via EXPLAIN ANALYZE:",
                    "p50=${percentile(execution, 0.50)} ms p95=${percentile(execution, 0.95)} ms",
                    "Includes real jOOQ SQL and conversion in repository wall clock.",
                    "Excludes HTTP, authentication, browser and network fanout.",
                ).joinToString("\n", postfix = "\n"),
            )
        }
    }
}
