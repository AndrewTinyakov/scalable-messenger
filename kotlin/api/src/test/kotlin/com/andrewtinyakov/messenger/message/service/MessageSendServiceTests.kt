package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
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
        private val batches: MessageSendBatchService,
        private val messageSendStatusService: MessageSendStatusService,
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

            assertEquals(SendLookupStatus.UNKNOWN, messageSendStatusService.status(UserId(sender), RequestId(requestId)).status)
            service.process(valid)
            assertEquals(SendLookupStatus.SAVED, messageSendStatusService.status(UserId(sender), RequestId(requestId)).status)
        }

        @Test
        fun `duplicate command saves once and preserves sequence`() {
            val sender = user("alice")
            val recipient = user("bob")
            val chat = newId()
            val request = newId()
            legacyJdbc.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            legacyJdbc.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?),(?,?)", chat, sender, chat, recipient)
            val send = command(sender, request, "hello", chat = chat)

            service.process(send)
            service.process(send)

            assertEquals(1, legacyJdbc.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals(
                2,
                legacyJdbc.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?", Int::class.java, chat),
            )
            assertEquals(2L, legacyJdbc.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
        }

        @Test
        fun `failed request insert rolls back the batched message and sequence before retry`() {
            val sender = user("batch-rollback-sender")
            val recipient = user("batch-rollback-recipient")
            val chat = newId()
            val request = newId()
            legacyJdbc.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            legacyJdbc.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?),(?,?)", chat, sender, chat, recipient)
            val constraint = "reject_${newId()}"
            legacyJdbc.execute("ALTER TABLE send_requests ADD CONSTRAINT \"$constraint\" CHECK (sender_id <> '$sender')")
            val body = "quoted ' body \\ 🦊\nsecond line"
            val send = command(sender, request, body, chat = chat)
            try {
                assertThrows(RuntimeException::class.java) { service.process(send) }
                assertEquals(0, legacyJdbc.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
                assertEquals(
                    0,
                    legacyJdbc.queryForObject(
                        "SELECT count(*) FROM send_requests WHERE sender_id=? AND request_id=?",
                        Int::class.java,
                        sender,
                        request,
                    ),
                )
                assertEquals(1L, legacyJdbc.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
                assertEquals(
                    0,
                    legacyJdbc.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?", Int::class.java, chat),
                )
            } finally {
                legacyJdbc.execute("ALTER TABLE send_requests DROP CONSTRAINT \"$constraint\"")
            }
            service.process(send)
            assertEquals(body, legacyJdbc.queryForObject("SELECT body FROM messages WHERE chat_id=?", String::class.java, chat))
            assertEquals(1, legacyJdbc.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals(2L, legacyJdbc.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
        }

        @Test
        fun `direct chat appears only with its first saved message`() {
            val sender = user("direct-sender")
            val recipient = user("direct-recipient")
            val request = newId()
            val pair = listOf(sender, recipient).sorted().joinToString(":")
            assertEquals(0, legacyJdbc.queryForObject("SELECT count(*) FROM chats WHERE direct_pair_key=?", Int::class.java, pair))

            val send = command(sender, request, "hello", recipient = recipient)
            service.process(send)
            service.process(send)

            val chat = messageSendStatusService.status(UserId(sender), RequestId(request)).chatId!!
            assertEquals(1, legacyJdbc.queryForObject("SELECT count(*) FROM chats WHERE direct_pair_key=?", Int::class.java, pair))
            assertEquals(1, legacyJdbc.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals(
                2,
                legacyJdbc.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='chat_created' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat,
                ),
            )
            assertEquals(
                2,
                legacyJdbc.queryForObject(
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
            val chat = legacyJdbc.queryForObject("SELECT id FROM chats WHERE direct_pair_key=?", String::class.java, pair)!!
            assertEquals(1, legacyJdbc.queryForObject("SELECT count(*) FROM chats WHERE direct_pair_key=?", Int::class.java, pair))
            assertEquals(
                listOf(1L, 2L),
                legacyJdbc.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
            )
        }

        @Test
        fun `rejected sends preserve the next accepted group sequence`() {
            val owner = user("removed-send-owner")
            val member = user("removed-send-member")
            val chat = chatService.createGroup(UserId(owner), "Group", listOf(member).map(::UserId))
            val requestId = newId()

            listOf(" " to SendRejectionReason.EMPTY_BODY, "x".repeat(4001) to SendRejectionReason.BODY_TOO_LONG).forEach { (body, reason) ->
                val invalidRequest = newId()
                service.process(command(member, invalidRequest, body, chat = chat.id))
                assertEquals(reason, messageSendStatusService.status(UserId(member), RequestId(invalidRequest)).reason)
            }
            chatMembershipService.removeMember(ChatId(chat.id), UserId(owner), UserId(member))
            service.process(command(member, requestId, "after removal", chat = chat.id))

            assertEquals(SendRejectionReason.NOT_A_MEMBER, messageSendStatusService.status(UserId(member), RequestId(requestId)).reason)
            assertEquals(0, legacyJdbc.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat.id))
            assertEquals(
                2L,
                legacyJdbc.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat.id),
                "only the removal took a number",
            )

            val acceptedRequest = newId()
            service.process(command(owner, acceptedRequest, "first saved message", chat = chat.id))

            assertEquals("2", messageSendStatusService.status(UserId(owner), RequestId(acceptedRequest)).sequence)
            assertEquals(listOf(2L), legacyJdbc.queryForList("SELECT sequence FROM messages WHERE chat_id=?", Long::class.java, chat.id))
            assertEquals(3L, legacyJdbc.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat.id))
        }

        @Test
        fun `revoked member has durable rejection without a message`() {
            val sender = user("charlie")
            val recipient = user("dana")
            val chat = newId()
            val request = newId()
            legacyJdbc.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            legacyJdbc.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?)", chat, recipient)

            service.process(command(sender, request, "hello", chat = chat))

            assertEquals("REJECTED", legacyJdbc.queryForObject("SELECT status FROM send_requests WHERE request_id=?", String::class.java, request))
            assertEquals(0, legacyJdbc.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
            assertEquals(SendLookupStatus.REJECTED, messageSendStatusService.status(UserId(sender), RequestId(request)).status)
            assertEquals(SendLookupStatus.UNKNOWN, messageSendStatusService.status(UserId(sender), RequestId(newId())).status)
        }

        @Test
        fun `invalid recipient does not create a chat`() {
            val sender = user("invalid-recipient-sender")
            val request = newId()
            service.process(command(sender, request, "hello", recipient = newId()))
            assertEquals(
                SendRejectionReason.RECIPIENT_NOT_FOUND,
                messageSendStatusService.status(UserId(sender), RequestId(request)).reason,
            )
            assertEquals(null, messageSendStatusService.status(UserId(sender), RequestId(request)).chatId)
        }

        @Test
        fun `single and batched chat sends share one rejection order`() {
            val owner = user("rejection-order-owner")
            val member = user("rejection-order-member")
            val outsider = user("rejection-order-outsider")
            val chat = chatService.createGroup(UserId(owner), "Rejection order", listOf(member).map(::UserId)).id
            val target = newId()
            service.process(command(owner, target, "target", chat = chat))
            val targetId = messageSendStatusService.status(UserId(owner), RequestId(target)).messageId!!

            fun replyAndForward(sender: String, body: String, chatId: String = chat) =
                command(sender, newId(), body, chat = chatId).copy(
                    replyToMessageId = targetId,
                    forwardFromChatId = chat,
                    forwardFromMessageId = targetId,
                )

            assertRejectedAlike(SendRejectionReason.EMPTY_BODY) { replyAndForward(member, " ") }
            assertRejectedAlike(SendRejectionReason.BODY_TOO_LONG) { replyAndForward(outsider, "x".repeat(4001)) }
            assertRejectedAlike(SendRejectionReason.CHAT_NOT_FOUND) { replyAndForward(member, "missing chat", chatId = newId()) }
            assertRejectedAlike(SendRejectionReason.NOT_A_MEMBER) { replyAndForward(outsider, "outsider") }
            assertRejectedAlike(SendRejectionReason.INVALID_FORWARD_SOURCE) { replyAndForward(member, "both references") }
            assertRejectedAlike(SendRejectionReason.INVALID_REPLY_TARGET) {
                command(member, newId(), "missing reply", chat = chat).copy(replyToMessageId = newId())
            }
            assertRejectedAlike(SendRejectionReason.INVALID_FORWARD_SOURCE) {
                command(member, newId(), "missing source", chat = chat).copy(forwardFromChatId = chat, forwardFromMessageId = newId())
            }
        }

        @Test
        fun `direct send with one invalid field keeps its reason and creates no chat`() {
            val sender = user("direct-invalid-sender")
            val recipient = user("direct-invalid-recipient")
            val pair = listOf(sender, recipient).sorted().joinToString(":")

            assertRejectedAlike(SendRejectionReason.INVALID_RECIPIENT) { command(sender, newId(), "self", recipient = sender) }
            assertRejectedAlike(SendRejectionReason.RECIPIENT_NOT_FOUND) { command(sender, newId(), "nobody", recipient = newId()) }
            assertRejectedAlike(SendRejectionReason.EMPTY_BODY) { command(sender, newId(), " ", recipient = recipient) }
            assertRejectedAlike(SendRejectionReason.INVALID_REPLY_TARGET) {
                command(sender, newId(), "reply", recipient = recipient).copy(replyToMessageId = newId())
            }
            assertRejectedAlike(SendRejectionReason.INVALID_FORWARD_SOURCE) {
                command(sender, newId(), "forward", recipient = recipient).copy(forwardFromChatId = newId(), forwardFromMessageId = newId())
            }
            assertRejectedAlike(SendRejectionReason.INVALID_REPLY_TARGET) {
                command(sender, newId(), " ", recipient = recipient).copy(replyToMessageId = newId())
            }
            assertEquals(0, legacyJdbc.queryForObject("SELECT count(*) FROM chats WHERE direct_pair_key=?", Int::class.java, pair))
        }

        private fun assertRejectedAlike(reason: SendRejectionReason, send: () -> SendMessageCommandV1) {
            val single = send()
            val batched = send()
            assertEquals(CommandResult.REJECTED, service.process(single))
            assertEquals(listOf(CommandResult.REJECTED), batches.process(listOf(batched)))
            listOf(single, batched).forEach { command ->
                assertEquals(reason, messageSendStatusService.status(UserId(command.senderId), RequestId(command.requestId)).reason)
            }
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
                legacyJdbc.queryForObject("SELECT reason FROM send_requests WHERE request_id=?", String::class.java, request),
            )
            assertEquals(
                1,
                legacyJdbc.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'requestId'=?", Int::class.java, request),
            )
        }
    }
