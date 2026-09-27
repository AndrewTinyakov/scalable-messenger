package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.AddGroupMembersRequest
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.shared.id.newId
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
import java.util.concurrent.CompletableFuture

@SpringBootTest(
    classes = [ApiApplication::class],
    properties = ["spring.rabbitmq.dynamic=false", "spring.rabbitmq.listener.simple.auto-startup=false"],
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class MessageSendServiceTests
    @Autowired
    constructor(
        private val db: JdbcTemplate,
        private val service: MessageSendService,
        private val chats: ChatService,
        private val chatRepository: ChatRepository,
        private val membership: ChatMembershipService,
        private val history: MessageHistoryService,
        private val outbox: OutboxRepository,
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

        private fun user(name: String): String = newId().also { id ->
            db.update("INSERT INTO users(id,username,password_hash) VALUES (?,?,'x')", id, name)
        }

        private fun command(sender: String, request: String, body: String, chat: String? = null, recipient: String? = null) =
            SendMessageCommandV1(
                version = 1,
                chatId = chat,
                recipientId = recipient,
                requestId = request,
                senderId = sender,
                body = body,
                sentAt = OffsetDateTime.parse("2026-09-26T10:00:00Z"),
            )

        @Test
        fun `batch send status preserves order and hides other users results`() {
            val sender = user("batch-status-sender")
            val recipient = user("batch-status-recipient")
            val other = user("batch-status-other")
            val saved = newId()
            val rejected = newId()
            val otherRequest = newId()
            val unknown = newId()
            service.process(command(sender, saved, "hello", recipient = recipient))
            service.process(command(sender, rejected, "hello", recipient = newId()))
            service.process(command(other, otherRequest, "hello", recipient = recipient))

            val statuses = history.statuses(sender, listOf(saved, rejected, otherRequest, unknown)).results
            assertEquals(listOf(saved, rejected, otherRequest, unknown), statuses.map { it.requestId })
            assertEquals(listOf("saved", "rejected", "unknown", "unknown"), statuses.map { it.result.status })
            assertEquals(null, statuses[2].result.chatId)
            assertThrows(RuntimeException::class.java) { history.statuses(sender, listOf(saved, saved)) }
        }

        @Test
        fun `batch group membership returns only groups joined by user`() {
            val owner = user("batch-group-owner")
            val member = user("batch-group-member")
            val other = user("batch-group-other")
            val included = chats.createGroup(owner, CreateGroupChatRequest("Included", listOf(member)))
            val excluded = chats.createGroup(owner, CreateGroupChatRequest("Excluded", listOf(other)))
            assertEquals(setOf(included.id), chatRepository.groupMemberships(listOf(included.id, excluded.id), member))
        }

        @Test
        fun `duplicate command saves once and preserves sequence`() {
            val sender = user("alice")
            val recipient = user("bob")
            val chat = newId()
            val request = newId()
            db.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'direct',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            db.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?),(?,?)", chat, sender, chat, recipient)
            val send = command(sender, request, "hello", chat = chat)

            service.process(send)
            service.process(send)

            assertEquals(1, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals(
                2,
                db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?", Int::class.java, chat),
            )
            assertEquals(2L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
        }

        @Test
        fun `direct chat appears only with its first saved message`() {
            val sender = user("direct-sender")
            val recipient = user("direct-recipient")
            val request = newId()
            val pair = listOf(sender, recipient).sorted().joinToString(":")
            assertEquals(0, db.queryForObject("SELECT count(*) FROM chats WHERE direct_pair_key=?", Int::class.java, pair))

            val send = command(sender, request, "hello", recipient = recipient)
            service.process(send)
            service.process(send)

            val chat = history.status(sender, request).chatId!!
            assertEquals(1, db.queryForObject("SELECT count(*) FROM chats WHERE direct_pair_key=?", Int::class.java, pair))
            assertEquals(1, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='chat_created' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat,
                ),
            )
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='message_saved' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat,
                ),
            )
        }

        @Test
        fun `opposite first sends share one direct chat`() {
            val left = user("direct-left")
            val right = user("direct-right")
            val first = CompletableFuture.runAsync { service.process(command(left, newId(), "from left", recipient = right)) }
            val second = CompletableFuture.runAsync { service.process(command(right, newId(), "from right", recipient = left)) }
            CompletableFuture.allOf(first, second).join()

            val pair = listOf(left, right).sorted().joinToString(":")
            val chat = db.queryForObject("SELECT id FROM chats WHERE direct_pair_key=?", String::class.java, pair)!!
            assertEquals(1, db.queryForObject("SELECT count(*) FROM chats WHERE direct_pair_key=?", Int::class.java, pair))
            assertEquals(
                listOf(1L, 2L),
                db.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
            )
        }

        @Test
        fun `group creation notifies every member`() {
            val owner = user("group-owner")
            val member = user("group-member")
            val chat = chats.createGroup(owner, CreateGroupChatRequest("Group", listOf(member)))
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='chat_created' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'chatId'=?",
                    Int::class.java,
                    "user:$member",
                    chat.id,
                ),
            )
        }

        @Test
        fun `removing a group member updates the count and writes a personal-room event`() {
            val owner = user("remove-owner")
            val member = user("remove-member")
            val chat = chats.createGroup(owner, CreateGroupChatRequest("Group", listOf(member)))
            assertEquals(2, chat.memberCount)

            membership.removeMember(chat.id, owner, member)

            assertEquals(1, chats.get(chat.id, owner).memberCount)
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'type'='member_removed' AND payload->>'chatId'=?",
                    Int::class.java,
                    "user:$member",
                    chat.id,
                ),
            )
        }

        @Test
        fun `adding group members updates the count without duplicate notifications`() {
            val owner = user("add-owner")
            val first = user("add-first")
            val second = user("add-second")
            val chat = chats.createGroup(owner, CreateGroupChatRequest("Group", listOf(first)))

            chats.addMembers(chat.id, owner, AddGroupMembersRequest(listOf(first, second)))
            chats.addMembers(chat.id, owner, AddGroupMembersRequest(listOf(second)))

            assertEquals(3, chats.get(chat.id, owner).memberCount)
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'type'='chat_created' AND payload->>'chatId'=?",
                    Int::class.java,
                    "user:$second",
                    chat.id,
                ),
            )
        }

        @Test
        fun `large group list returns an exact count and a bounded member preview`() {
            val owner = user("preview-owner")
            val members = (1..60).map { user("preview-member-$it") }
            val chat = chats.createGroup(owner, CreateGroupChatRequest("Group", members))

            val listed = chats.list(owner, null, 50).chats.first { it.id == chat.id }
            val opened = chats.get(chat.id, owner)

            assertEquals(61, listed.memberCount)
            assertEquals(0, listed.members.size)
            assertEquals(50, opened.members.size)
        }

        @Test
        fun `chat list cursor visits each chat once when join times tie`() {
            val owner = user("page-owner")
            val member = user("page-member")
            val ids = (1..3).map { chats.createGroup(owner, CreateGroupChatRequest("Page $it", listOf(member))).id }
            db.update("UPDATE chat_members SET joined_at='2026-09-26 10:00:00+00' WHERE user_id=?", owner)

            val first = chats.list(owner, null, 2)
            val second = chats.list(owner, first.nextCursor, 2)

            assertEquals(ids.toSet(), (first.chats + second.chats).map { it.id }.toSet())
            assertEquals(2, first.chats.size)
            assertEquals(1, second.chats.size)
            assertEquals(null, second.nextCursor)
        }

        @Test
        fun `history defaults to latest and pages backward without breaking forward catch up`() {
            val owner = user("history-owner")
            val member = user("history-member")
            val chat = chats.createGroup(owner, CreateGroupChatRequest("History", listOf(member)))
            (1..5).forEach { service.process(command(owner, newId(), "message $it", chat = chat.id)) }

            val latest = history.messages(chat.id, owner, null, null, 2)
            assertEquals(listOf("4", "5"), latest.messages.map { it.sequence })
            assertEquals("4", latest.nextSequence)
            assertEquals(true, latest.hasMore)

            val older = history.messages(chat.id, owner, null, latest.nextSequence, 2)
            assertEquals(listOf("2", "3"), older.messages.map { it.sequence })
            assertEquals("2", older.nextSequence)
            assertEquals(true, older.hasMore)

            val oldest = history.messages(chat.id, owner, null, older.nextSequence, 2)
            assertEquals(listOf("1"), oldest.messages.map { it.sequence })
            assertEquals(false, oldest.hasMore)

            val catchup = history.messages(chat.id, owner, "3", null, 2)
            assertEquals(listOf("4", "5"), catchup.messages.map { it.sequence })
            assertEquals("5", catchup.nextSequence)
            assertEquals(false, catchup.hasMore)
        }

        @Test
        fun `outbox completion deletes only rows leased by this publisher`() {
            val owned = newId()
            val other = newId()
            db.update(
                "INSERT INTO messenger_outbox_events(id,room,payload,lease_owner) VALUES (?,'user:test','{}'::jsonb,'publisher-a')," +
                    "(?,'user:test','{}'::jsonb,'publisher-b')",
                owned,
                other,
            )

            outbox.complete(listOf(owned), "publisher-a")

            assertEquals(0, db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE id=?", Int::class.java, owned))
            assertEquals(1, db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE id=?", Int::class.java, other))
        }

        @Test
        fun `revoked member has durable rejection without a message`() {
            val sender = user("charlie")
            val recipient = user("dana")
            val chat = newId()
            val request = newId()
            db.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'direct',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            db.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?)", chat, recipient)

            service.process(command(sender, request, "hello", chat = chat))

            assertEquals("rejected", db.queryForObject("SELECT status FROM send_requests WHERE request_id=?", String::class.java, request))
            assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals("rejected", history.status(sender, request).status)
            assertEquals("unknown", history.status(sender, newId()).status)
        }

        @Test
        fun `invalid recipient does not create a chat`() {
            val sender = user("invalid-recipient-sender")
            val request = newId()
            service.process(command(sender, request, "hello", recipient = newId()))
            assertEquals("RECIPIENT_NOT_FOUND", history.status(sender, request).reason)
            assertEquals(null, history.status(sender, request).chatId)
        }

        @Test
        fun `exhausted command gets a durable rejection`() {
            val sender = user("exhausted")
            val chat = newId()
            val request = newId()
            val send = command(sender, request, "hello", chat = chat)

            service.rejectExhausted(send)
            service.rejectExhausted(send)

            assertEquals(
                "PROCESSING_FAILED",
                db.queryForObject("SELECT reason FROM send_requests WHERE request_id=?", String::class.java, request),
            )
            assertEquals(
                1,
                db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'requestId'=?", Int::class.java, request),
            )
        }

        @Test
        fun `command decoder rejects unknown fields and trailing JSON`() {
            val send = command(newId(), newId(), "hello", chat = newId())
            val json = mapper.writeValueAsString(send)
            assertEquals(send, mapper.readValue(json, SendMessageCommandV1::class.java))
            assertThrows(JacksonException::class.java) {
                mapper.readValue(json.dropLast(1) + ",\"unknown\":true}", SendMessageCommandV1::class.java)
            }
            assertThrows(JacksonException::class.java) { mapper.readValue("$json {}", SendMessageCommandV1::class.java) }
            val rejection = SendRejectedEventV1(
                type = "send_rejected",
                version = 1,
                eventId = newId(),
                room = "user:${newId()}",
                chatId = newId(),
                requestId = newId(),
                reason = SendRejectionReason.NOT_A_MEMBER,
            )
            assertFalse(mapper.writeValueAsString(rejection).contains("messageId"))
        }
    }
