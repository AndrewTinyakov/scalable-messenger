package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.SendResultStatus
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.util.concurrent.CompletableFuture
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.SendRejectionReason as StoredSendRejectionReason

class MessageSendServiceTests
    @Autowired
    constructor(
        private val service: MessageSendService,
        private val batches: MessageSendBatchService,
        private val messageSendStatusService: MessageSendStatusService,
        private val chatService: ChatService,
        private val chatMembershipService: ChatMembershipService,
    ) : MessengerIntegrationTest() {
        private val outboxChatId = DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "chatId")

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
            db.insertInto(CHATS, CHATS.ID, CHATS.KIND, CHATS.DIRECT_PAIR_KEY)
                .values(chat, ChatKind.DIRECT, listOf(sender, recipient).sorted().joinToString(":"))
                .execute()
            db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID)
                .values(chat, sender)
                .values(chat, recipient)
                .execute()
            val send = command(sender, request, "hello", chat = chat)

            service.process(send)
            service.process(send)

            assertEquals(1, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
            assertEquals(
                2,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, outboxChatId.eq(chat)),
            )
            assertEquals(2L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
        }

        @Test
        fun `failed request insert rolls back the batched message and sequence before retry`() {
            val sender = user("batch-rollback-sender")
            val recipient = user("batch-rollback-recipient")
            val chat = newId()
            val request = newId()
            db.insertInto(CHATS, CHATS.ID, CHATS.KIND, CHATS.DIRECT_PAIR_KEY)
                .values(chat, ChatKind.DIRECT, listOf(sender, recipient).sorted().joinToString(":"))
                .execute()
            db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID)
                .values(chat, sender)
                .values(chat, recipient)
                .execute()
            val constraint = "reject_${newId()}"
            db.alterTable(SEND_REQUESTS)
                .add(DSL.constraint(DSL.name(constraint)).check(SEND_REQUESTS.SENDER_ID.ne(sender)))
                .execute()
            val body = "quoted ' body \\ 🦊\nsecond line"
            val send = command(sender, request, body, chat = chat)
            try {
                assertThrows(RuntimeException::class.java) { service.process(send) }
                assertEquals(0, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
                assertEquals(
                    0,
                    db.fetchCount(SEND_REQUESTS, SEND_REQUESTS.SENDER_ID.eq(sender).and(SEND_REQUESTS.REQUEST_ID.eq(request))),
                )
                assertEquals(1L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
                assertEquals(
                    0,
                    db.fetchCount(MESSENGER_OUTBOX_EVENTS, outboxChatId.eq(chat)),
                )
            } finally {
                db.alterTable(SEND_REQUESTS).dropConstraint(DSL.name(constraint)).execute()
            }
            service.process(send)
            assertEquals(body, db.select(MESSAGES.BODY).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat)).fetchSingle().value1())
            assertEquals(1, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
            assertEquals(2L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
        }

        @Test
        fun `direct chat appears only with its first saved message`() {
            val sender = user("direct-sender")
            val recipient = user("direct-recipient")
            val request = newId()
            val pair = listOf(sender, recipient).sorted().joinToString(":")
            assertEquals(0, db.fetchCount(CHATS, CHATS.DIRECT_PAIR_KEY.eq(pair)))

            val send = command(sender, request, "hello", recipient = recipient)
            service.process(send)
            service.process(send)

            val chat = messageSendStatusService.status(UserId(sender), RequestId(request)).chatId!!
            assertEquals(1, db.fetchCount(CHATS, CHATS.DIRECT_PAIR_KEY.eq(pair)))
            assertEquals(1, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
            assertEquals(
                2,
                db.fetchCount(
                    MESSENGER_OUTBOX_EVENTS,
                    DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq("chat_created")
                        .and(outboxChatId.eq(chat)),
                ),
            )
            assertEquals(
                2,
                db.fetchCount(
                    MESSENGER_OUTBOX_EVENTS,
                    DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq("message_saved")
                        .and(outboxChatId.eq(chat)),
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
            val chat = db.select(CHATS.ID).from(CHATS).where(CHATS.DIRECT_PAIR_KEY.eq(pair)).fetchSingle().value1()
            assertEquals(1, db.fetchCount(CHATS, CHATS.DIRECT_PAIR_KEY.eq(pair)))
            assertEquals(
                listOf(1L, 2L),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                    .orderBy(MESSAGES.SEQUENCE)
                    .fetch(MESSAGES.SEQUENCE),
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
            assertEquals(0, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat.id)))
            assertEquals(
                2L,
                db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat.id)).fetchSingle().value1(),
                "only the removal took a number",
            )

            val acceptedRequest = newId()
            service.process(command(owner, acceptedRequest, "first saved message", chat = chat.id))

            assertEquals("2", messageSendStatusService.status(UserId(owner), RequestId(acceptedRequest)).sequence)
            assertEquals(
                listOf(2L),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.id)).fetch(MESSAGES.SEQUENCE),
            )
            assertEquals(3L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat.id)).fetchSingle().value1())
        }

        @Test
        fun `revoked member has durable rejection without a message`() {
            val sender = user("charlie")
            val recipient = user("dana")
            val chat = newId()
            val request = newId()
            db.insertInto(CHATS, CHATS.ID, CHATS.KIND, CHATS.DIRECT_PAIR_KEY)
                .values(chat, ChatKind.DIRECT, listOf(sender, recipient).sorted().joinToString(":"))
                .execute()
            db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID).values(chat, recipient).execute()

            service.process(command(sender, request, "hello", chat = chat))

            assertEquals(
                SendResultStatus.REJECTED,
                db.select(SEND_REQUESTS.STATUS).from(SEND_REQUESTS).where(SEND_REQUESTS.REQUEST_ID.eq(request)).fetchSingle().value1(),
            )
            assertEquals(0, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
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
            assertEquals(0, db.fetchCount(CHATS, CHATS.DIRECT_PAIR_KEY.eq(pair)))
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
                StoredSendRejectionReason.PROCESSING_FAILED,
                db.select(SEND_REQUESTS.REASON).from(SEND_REQUESTS).where(SEND_REQUESTS.REQUEST_ID.eq(request)).fetchSingle().value1(),
            )
            assertEquals(
                1,
                db.fetchCount(
                    MESSENGER_OUTBOX_EVENTS,
                    DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "requestId").eq(request),
                ),
            )
        }
    }
