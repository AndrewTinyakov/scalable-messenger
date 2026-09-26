package com.andrewtinyakov.messenger.messaging

import com.andrewtinyakov.messenger.conversation.HistoryService
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.shared.ApiException
import com.andrewtinyakov.messenger.shared.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import tools.jackson.core.JacksonException
import tools.jackson.databind.ObjectMapper
import java.time.OffsetDateTime

@SpringBootTest(properties = ["messenger.role=http", "spring.rabbitmq.dynamic=false"])
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SendCommandServiceTests
    @Autowired
    constructor(
        private val db: JdbcTemplate,
        private val service: SendCommandService,
        private val history: HistoryService,
        private val mapper: ObjectMapper,
    ) {
        companion object {
            private val postgres = PostgreSQLContainer<Nothing>("postgres:17-alpine").apply {
                withDatabaseName("messenger")
                withUsername("messenger")
                withPassword("messenger")
                start()
            }

            @JvmStatic
            @DynamicPropertySource
            fun properties(registry: DynamicPropertyRegistry) {
                registry.add("spring.datasource.url", postgres::getJdbcUrl)
                registry.add("spring.datasource.username", postgres::getUsername)
                registry.add("spring.datasource.password", postgres::getPassword)
            }
        }

        @Test
        fun `duplicate command saves once and preserves sequence`() {
            val sender = newId()
            val recipient = newId()
            val conversation = newId()
            val request = newId()
            db.update("INSERT INTO users(id,username,password_hash) VALUES (?,'alice','x'),(?,'bob','x')", sender, recipient)
            db.update(
                "INSERT INTO conversations(id,kind,direct_pair_key) VALUES (?,'direct',?)",
                conversation,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            db.update(
                "INSERT INTO conversation_members(conversation_id,user_id) VALUES (?,?),(?,?)",
                conversation,
                sender,
                conversation,
                recipient,
            )
            val command = SendMessageCommandV1(1, conversation, request, sender, "hello", OffsetDateTime.parse("2026-09-26T10:00:00Z"))

            service.process(command)
            service.process(command)

            assertEquals(1, db.queryForObject("SELECT count(*) FROM messages WHERE conversation_id=?", Int::class.java, conversation))
            assertEquals(
                2,
                db.queryForObject("SELECT count(*) FROM outbox_events WHERE payload->>'conversationId'=?", Int::class.java, conversation),
            )
            assertEquals(2L, db.queryForObject("SELECT next_sequence FROM conversations WHERE id=?", Long::class.java, conversation))
        }

        @Test
        fun `revoked member has durable rejection without a message`() {
            val sender = newId()
            val recipient = newId()
            val conversation = newId()
            val request = newId()
            db.update("INSERT INTO users(id,username,password_hash) VALUES (?,'charlie','x'),(?,'dana','x')", sender, recipient)
            db.update(
                "INSERT INTO conversations(id,kind,direct_pair_key) VALUES (?,'direct',?)",
                conversation,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            db.update("INSERT INTO conversation_members(conversation_id,user_id) VALUES (?,?)", conversation, recipient)

            service.process(SendMessageCommandV1(1, conversation, request, sender, "hello", OffsetDateTime.parse("2026-09-26T10:00:00Z")))

            assertEquals("rejected", db.queryForObject("SELECT status FROM send_requests WHERE request_id=?", String::class.java, request))
            assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE conversation_id=?", Int::class.java, conversation))
            assertEquals(1, db.queryForObject("SELECT count(*) FROM outbox_events WHERE room=?", Int::class.java, "user:$sender"))
            assertEquals("rejected", history.status(conversation, sender, request).status)
            assertEquals(404, assertThrows(ApiException::class.java) { history.status(conversation, sender, newId()) }.status)
        }

        @Test
        fun `exhausted command gets a durable rejection`() {
            val sender = newId()
            val conversation = newId()
            val request = newId()
            db.update("INSERT INTO users(id,username,password_hash) VALUES (?,'exhausted','x')", sender)
            val command = SendMessageCommandV1(1, conversation, request, sender, "hello", OffsetDateTime.parse("2026-09-26T10:00:00Z"))

            service.rejectExhausted(command)
            service.rejectExhausted(command)

            assertEquals(
                "PROCESSING_FAILED",
                db.queryForObject("SELECT reason FROM send_requests WHERE request_id=?", String::class.java, request),
            )
            assertEquals(1, db.queryForObject("SELECT count(*) FROM outbox_events WHERE payload->>'requestId'=?", Int::class.java, request))
        }

        @Test
        fun `command decoder rejects unknown fields and trailing JSON`() {
            val command = SendMessageCommandV1(1, newId(), newId(), newId(), "hello", OffsetDateTime.parse("2026-09-26T10:00:00Z"))
            val json = mapper.writeValueAsString(command)
            assertEquals(command, mapper.readValue(json, SendMessageCommandV1::class.java))
            assertThrows(JacksonException::class.java) {
                mapper.readValue(json.dropLast(1) + ",\"unknown\":true}", SendMessageCommandV1::class.java)
            }
            assertThrows(JacksonException::class.java) { mapper.readValue("$json {}", SendMessageCommandV1::class.java) }
            val rejection =
                RoomEventV1(
                    "send_rejected",
                    eventId = newId(),
                    room = "user:${newId()}",
                    conversationId = newId(),
                    requestId = newId(),
                    reason = "NOT_A_MEMBER",
                )
            assertFalse(mapper.writeValueAsString(rejection).contains("messageId"))
        }
    }
