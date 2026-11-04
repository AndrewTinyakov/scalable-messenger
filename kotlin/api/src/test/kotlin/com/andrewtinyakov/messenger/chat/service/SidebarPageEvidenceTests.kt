package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.JooqChatRepository
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
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
            val statements = mutableListOf<String>()
            val listener = object : ExecuteListener {
                override fun executeStart(ctx: ExecuteContext) {
                    ctx.query()?.let { statements.add(it.getSQL(ParamType.INLINED)) }
                }
            }
            val db = DSL.using(connection, SQLDialect.POSTGRES)
            val repository = JooqChatRepository(DSL.using(db.configuration().derive(listener)))
            val viewer = UserId("00000000000000000000000001")

            fun page() {
                val chats = repository.findByMember(viewer, null, null, 101)
                assertEquals(101, chats.size)
                repository.findMembersByChatIds(chats.take(100).filter { it.chat.kind == ChatKind.DIRECT }.map { it.chat.id })
            }
            page()
            val sql = statements.first { it.contains("summary_candidates") }
            statements.clear()
            repeat(5) { page() }
            val wall = List(60) { measureNanoTime { page() } / 1_000_000.0 }.sorted()
            val mapper = JsonMapper.builder().build()
            val execution = List(60) {
                val json = db.fetch("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) $sql").single().get(0).toString()
                mapper.readTree(json).get(0).path("Execution Time").asDouble()
            }.sorted()

            fun percentile(values: List<Double>, p: Double) = values[ceil(values.size * p).toInt() - 1]
            val directory = Path.of("../../docs/evidence")
            Files.createDirectories(directory)
            Files.writeString(directory.resolve("sidebar-page.sql"), sql + ";\n")
            val plan = db.fetch("EXPLAIN (ANALYZE, BUFFERS) $sql").joinToString("\n") { it.get(0).toString() }
            Files.writeString(directory.resolve("sidebar-page-plan.txt"), plan + "\n")
            statements.clear()
            val large = repository.findMemberDetails(ChatId("00000000000000000010000000"), viewer)!!
            val largeSql = statements.last { it.contains("summary_candidates") }
            val largePlan = db.fetch("EXPLAIN (ANALYZE, BUFFERS) $largeSql").joinToString("\n") { it.get(0).toString() }
            Files.writeString(directory.resolve("sidebar-large-chat-plan.txt"), largePlan + "\n")
            val counts = db.fetch(
                """
                SELECT
                  (SELECT count(*) FROM messages WHERE chat_id='00000000000000000010000000') AS large_chat_messages,
                  (SELECT count(*) FROM chat_members WHERE user_id='00000000000000000000000001') AS viewer_chats,
                  (SELECT count(*) FROM hidden_message_ranges) AS exclusions
                """.trimIndent(),
            ).single()
            val exactUnread = db.fetchValue(
                """
                SELECT count(*) FROM messages
                WHERE chat_id='00000000000000000010000000' AND sequence>1000000
                  AND sender_id<>'00000000000000000000000001' AND sequence%10 NOT BETWEEN 1 AND 5
                """.trimIndent(),
            )
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
                    "PostgreSQL 17, isolated compose database, 2 CPU quota, 768 MiB limit.",
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
