package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.util.concurrent.CompletableFuture

class MessageSendServiceTests
    @Autowired
    constructor(
        private val service: MessageSendService,
        private val messageHistoryService: MessageHistoryService,
        private val chatService: ChatService,
        private val chatMembershipService: ChatMembershipService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `invalid command identities never record a request result`() {
            val sender = user("invalid-command-sender")
            val recipient = user("invalid-command-recipient")
            val requestId = newId()
            val valid = command(sender, requestId, "hello", recipient = recipient)
            val invalid = listOf(
                valid.copy(senderId = "invalid"),
                valid.copy(recipientId = "invalid"),
                valid.copy(requestId = "invalid"),
                valid.copy(chatId = "invalid", recipientId = null),
            )

            invalid.forEach { malformed ->
                assertThrows(IllegalArgumentException::class.java) { service.process(malformed) }
                assertThrows(IllegalArgumentException::class.java) { service.rejectExhausted(malformed) }
            }

            assertEquals(SendLookupStatus.UNKNOWN, messageHistoryService.status(UserId(sender), RequestId(requestId)).status)
            service.process(valid)
            assertEquals(SendLookupStatus.SAVED, messageHistoryService.status(UserId(sender), RequestId(requestId)).status)
        }

        @Test
        fun `duplicate command saves once and preserves sequence`() {
            val sender = user("alice")
            val recipient = user("bob")
            val chat = newId()
            val request = newId()
            db.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)",
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
        fun `failed request insert rolls back the batched message and sequence before retry`() {
            val sender = user("batch-rollback-sender")
            val recipient = user("batch-rollback-recipient")
            val chat = newId()
            val request = newId()
            db.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            db.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?),(?,?)", chat, sender, chat, recipient)
            val constraint = "reject_${newId()}"
            db.execute("ALTER TABLE send_requests ADD CONSTRAINT \"$constraint\" CHECK (sender_id <> '$sender')")
            val body = "quoted ' body \\ 🦊\nsecond line"
            val send = command(sender, request, body, chat = chat)
            try {
                assertThrows(RuntimeException::class.java) { service.process(send) }
                assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
                assertEquals(
                    0,
                    db.queryForObject(
                        "SELECT count(*) FROM send_requests WHERE sender_id=? AND request_id=?",
                        Int::class.java,
                        sender,
                        request,
                    ),
                )
                assertEquals(1L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
                assertEquals(
                    0,
                    db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?", Int::class.java, chat),
                )
            } finally {
                db.execute("ALTER TABLE send_requests DROP CONSTRAINT \"$constraint\"")
            }
            service.process(send)
            assertEquals(body, db.queryForObject("SELECT body FROM messages WHERE chat_id=?", String::class.java, chat))
            assertEquals(1, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
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

            val chat = messageHistoryService.status(UserId(sender), RequestId(request)).chatId!!
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
            val first = concurrently { service.process(command(left, newId(), "from left", recipient = right)) }
            val second = concurrently { service.process(command(right, newId(), "from right", recipient = left)) }
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
        fun `rejected sends preserve the next accepted group sequence`() {
            val owner = user("removed-send-owner")
            val member = user("removed-send-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Group", listOf(member)))
            val requestId = newId()

            listOf(" " to SendRejectionReason.EMPTY_BODY, "x".repeat(4001) to SendRejectionReason.BODY_TOO_LONG).forEach { (body, reason) ->
                val invalidRequest = newId()
                service.process(command(member, invalidRequest, body, chat = chat.id))
                assertEquals(reason, messageHistoryService.status(UserId(member), RequestId(invalidRequest)).reason)
            }
            chatMembershipService.removeMember(ChatId(chat.id), UserId(owner), UserId(member))
            service.process(command(member, requestId, "after removal", chat = chat.id))

            assertEquals(SendRejectionReason.NOT_A_MEMBER, messageHistoryService.status(UserId(member), RequestId(requestId)).reason)
            assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat.id))
            assertEquals(1L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat.id))

            val acceptedRequest = newId()
            service.process(command(owner, acceptedRequest, "first saved message", chat = chat.id))

            assertEquals("1", messageHistoryService.status(UserId(owner), RequestId(acceptedRequest)).sequence)
            assertEquals(listOf(1L), db.queryForList("SELECT sequence FROM messages WHERE chat_id=?", Long::class.java, chat.id))
            assertEquals(2L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat.id))
        }

        @Test
        fun `revoked member has durable rejection without a message`() {
            val sender = user("charlie")
            val recipient = user("dana")
            val chat = newId()
            val request = newId()
            db.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            db.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?)", chat, recipient)

            service.process(command(sender, request, "hello", chat = chat))

            assertEquals("REJECTED", db.queryForObject("SELECT status FROM send_requests WHERE request_id=?", String::class.java, request))
            assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals(SendLookupStatus.REJECTED, messageHistoryService.status(UserId(sender), RequestId(request)).status)
            assertEquals(SendLookupStatus.UNKNOWN, messageHistoryService.status(UserId(sender), RequestId(newId())).status)
        }

        @Test
        fun `invalid recipient does not create a chat`() {
            val sender = user("invalid-recipient-sender")
            val request = newId()
            service.process(command(sender, request, "hello", recipient = newId()))
            assertEquals(SendRejectionReason.RECIPIENT_NOT_FOUND, messageHistoryService.status(UserId(sender), RequestId(request)).reason)
            assertEquals(null, messageHistoryService.status(UserId(sender), RequestId(request)).chatId)
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
    }
