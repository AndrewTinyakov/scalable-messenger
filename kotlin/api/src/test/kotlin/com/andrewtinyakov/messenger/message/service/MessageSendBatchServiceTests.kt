package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.SendRejectionReason
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.MeterRegistry
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.impl.DSL
import org.jooq.impl.DefaultExecuteListenerProvider
import org.jooq.impl.SQLDataType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.transaction.support.TransactionTemplate
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MessageSendBatchServiceTests
    @Autowired
    constructor(
        private val batches: MessageSendBatchService,
        private val service: MessageSendService,
        private val transactions: TransactionTemplate,
        private val metrics: MeterRegistry,
        private val chats: ChatRepository,
    ) : MessengerIntegrationTest() {
        private val outboxChatId = DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "chatId")

        @Test
        fun `bulk sequence allocation enforces every sender membership in SQL`() {
            val sender = user("batch-sql-member")
            val recipient = user("batch-sql-recipient")
            val outsider = user("batch-sql-outsider")
            val chat = directChat(sender, recipient)

            assertNull(
                transactions.execute {
                    chats.allocateSequencesForMembers(ChatId(chat), listOf(UserId(sender), UserId(outsider)))
                },
            )
            assertEquals(1L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
            assertEquals(
                1L,
                transactions.execute {
                    chats.allocateSequencesForMembers(ChatId(chat), listOf(UserId(sender), UserId(sender), UserId(recipient)))
                },
            )
            assertEquals(4L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
        }

        @Test
        fun `full batch bounds SQL round trips while retaining every durable result`() {
            val sender = user("batch-round-trips-sender")
            val recipient = user("batch-round-trips-recipient")
            val chat = directChat(sender, recipient)
            val commands = (1..16).map { command(sender, newId(), "message $it", chat = chat) }
            val statements = AtomicInteger()
            val previous = db.configuration().executeListenerProviders()
            val listener = object : ExecuteListener {
                override fun executeStart(context: ExecuteContext) {
                    statements.incrementAndGet()
                }
            }
            db.configuration().set(*previous, DefaultExecuteListenerProvider(listener))
            try {
                assertEquals(List(16) { CommandResult.SAVED }, batches.process(commands))
            } finally {
                db.configuration().set(*previous)
            }

            assertTrue(statements.get() in 1..30, "Expected one to 30 SQL executions, observed ${statements.get()}")
            assertEquals(
                (1L..16L).toList(),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                    .orderBy(MESSAGES.SEQUENCE)
                    .fetch(MESSAGES.SEQUENCE),
            )
            assertEquals(16, db.fetchCount(SEND_REQUESTS, SEND_REQUESTS.CHAT_ID.eq(chat)))
            assertEquals(
                32,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, outboxChatId.eq(chat)),
            )
        }

        @Test
        fun `same request ID from different senders and conflicting retries preserve the first results`() {
            val sender = user("batch-conflict-sender")
            val recipient = user("batch-conflict-recipient")
            val chat = directChat(sender, recipient)
            val request = newId()
            val first = command(sender, request, "first", chat = chat)
            val otherSender = command(recipient, request, "other sender", chat = chat)
            val conflict = first.copy(body = "changed")

            assertEquals(
                listOf(CommandResult.SAVED, CommandResult.SAVED, CommandResult.CONFLICT, CommandResult.DUPLICATE),
                batches.process(listOf(first, otherSender, conflict, first)),
            )
            assertEquals(
                listOf(CommandResult.DUPLICATE, CommandResult.CONFLICT),
                batches.process(listOf(otherSender, conflict)),
            )
            assertEquals(
                listOf("first", "other sender"),
                db.select(MESSAGES.BODY).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat)).orderBy(MESSAGES.SEQUENCE).fetch(MESSAGES.BODY),
            )
            assertEquals(2, db.fetchCount(SEND_REQUESTS, SEND_REQUESTS.CHAT_ID.eq(chat)))
            assertEquals(3L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
        }

        @Test
        fun `joined send timing finishes after the outer transaction commits`() {
            val sender = user("batch-timing-sender")
            val recipient = user("batch-timing-recipient")
            val chat = directChat(sender, recipient)
            val names = listOf("messenger.send.transaction", "messenger.send.transaction.hold", "messenger.send.transaction.completion")
            val before = names.associateWith { metrics.find(it).timer()?.count() ?: 0L }

            transactions.executeWithoutResult {
                service.process(command(sender, newId(), "timed", chat = chat))
                names.forEach { assertEquals(before.getValue(it), metrics.find(it).timer()?.count() ?: 0L) }
            }

            names.forEach { assertEquals(before.getValue(it) + 1L, metrics.get(it).timer().count()) }
        }

        @Test
        fun `batch commits messages request results and outbox in one transaction with contiguous sequences`() {
            val sender = user("batch-atomic-sender")
            val recipient = user("batch-atomic-recipient")
            val chat = directChat(sender, recipient)
            val first = command(sender, newId(), "first", chat = chat)
            val second = command(sender, newId(), "second", chat = chat)

            assertEquals(
                listOf(CommandResult.SAVED, CommandResult.DUPLICATE, CommandResult.SAVED),
                batches.process(listOf(first, first, second)),
            )

            assertEquals(
                listOf(1L, 2L),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                    .orderBy(MESSAGES.SEQUENCE)
                    .fetch(MESSAGES.SEQUENCE),
            )
            assertEquals(3L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
            val transactionId = DSL.field(DSL.name("xmin"), SQLDataType.OTHER).cast(SQLDataType.CLOB).`as`(DSL.name("transaction_id"))
            val writes = db.select(transactionId).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                .unionAll(db.select(transactionId).from(SEND_REQUESTS).where(SEND_REQUESTS.CHAT_ID.eq(chat)))
                .unionAll(
                    db.select(transactionId).from(MESSENGER_OUTBOX_EVENTS)
                        .where(outboxChatId.eq(chat)),
                ).asTable(DSL.name("writes"))
            assertEquals(1, db.select(DSL.countDistinct(writes.field(transactionId)!!)).from(writes).fetchSingle().value1())
        }

        @Test
        fun `failure in a later command rolls back earlier batch writes`() {
            val sender = user("batch-failure-sender")
            val recipient = user("batch-failure-recipient")
            val chat = directChat(sender, recipient)
            val failingRequest = newId()
            val commands = listOf(command(sender, newId(), "first", chat = chat), command(sender, failingRequest, "fails", chat = chat))
            val constraint = "reject_${newId()}"
            db.alterTable(SEND_REQUESTS)
                .add(DSL.constraint(DSL.name(constraint)).check(SEND_REQUESTS.REQUEST_ID.ne(failingRequest)))
                .execute()
            try {
                assertThrows(RuntimeException::class.java) { batches.process(commands) }
                assertEquals(0, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
                assertEquals(0, db.fetchCount(SEND_REQUESTS, SEND_REQUESTS.CHAT_ID.eq(chat)))
                assertEquals(
                    0,
                    db.fetchCount(MESSENGER_OUTBOX_EVENTS, outboxChatId.eq(chat)),
                )
                assertEquals(1L, db.select(CHATS.NEXT_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
            } finally {
                db.alterTable(SEND_REQUESTS).dropConstraint(DSL.name(constraint)).execute()
            }
        }

        @Test
        fun `concurrent reversed overlapping retries complete without duplicate sequences`() {
            val sender = user("batch-reversed-sender")
            val recipient = user("batch-reversed-recipient")
            val chat = directChat(sender, recipient)
            val commands = (1..8).map { command(sender, newId(), "message $it", chat = chat) }
            val first = concurrently { batches.process(commands) }
            val second = concurrently { batches.process(commands.reversed()) }

            CompletableFuture.allOf(first, second).get(15, TimeUnit.SECONDS)

            assertEquals(
                (1L..8L).toList(),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                    .orderBy(MESSAGES.SEQUENCE)
                    .fetch(MESSAGES.SEQUENCE),
            )
        }

        @Test
        fun `nonmember in a batch cannot consume a sequence`() {
            val sender = user("batch-member")
            val recipient = user("batch-recipient")
            val outsider = user("batch-outsider")
            val chat = directChat(sender, recipient)
            val rejected = command(outsider, newId(), "forbidden", chat = chat)

            assertEquals(
                listOf(CommandResult.SAVED, CommandResult.REJECTED, CommandResult.SAVED),
                batches.process(
                    listOf(command(sender, newId(), "first", chat = chat), rejected, command(sender, newId(), "second", chat = chat)),
                ),
            )

            assertEquals(
                SendRejectionReason.NOT_A_MEMBER,
                db.select(SEND_REQUESTS.REASON).from(SEND_REQUESTS).where(SEND_REQUESTS.REQUEST_ID.eq(rejected.requestId))
                    .fetchSingle().value1(),
            )
            assertEquals(
                listOf(1L, 2L),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                    .orderBy(MESSAGES.SEQUENCE)
                    .fetch(MESSAGES.SEQUENCE),
            )
        }

        @Test
        fun `invalid bodies and self recipients retain durable domain rejections`() {
            val sender = user("batch-invalid-sender")
            val recipient = user("batch-invalid-recipient")
            val chat = directChat(sender, recipient)
            val blank = command(sender, newId(), " ", chat = chat)
            val oversized = command(sender, newId(), "x".repeat(4001), chat = chat)
            val valid = command(sender, newId(), "valid", chat = chat)
            val self = command(sender, newId(), "self", recipient = sender)

            assertEquals(
                listOf(CommandResult.REJECTED, CommandResult.REJECTED, CommandResult.SAVED),
                batches.process(listOf(blank, oversized, valid)),
            )
            assertEquals(listOf(CommandResult.REJECTED), batches.process(listOf(self)))

            assertEquals(
                SendRejectionReason.EMPTY_BODY,
                db.select(SEND_REQUESTS.REASON).from(SEND_REQUESTS).where(SEND_REQUESTS.REQUEST_ID.eq(blank.requestId))
                    .fetchSingle().value1(),
            )
            assertEquals(
                SendRejectionReason.BODY_TOO_LONG,
                db.select(SEND_REQUESTS.REASON).from(SEND_REQUESTS).where(SEND_REQUESTS.REQUEST_ID.eq(oversized.requestId))
                    .fetchSingle().value1(),
            )
            assertEquals(
                SendRejectionReason.INVALID_RECIPIENT,
                db.select(SEND_REQUESTS.REASON).from(SEND_REQUESTS).where(SEND_REQUESTS.REQUEST_ID.eq(self.requestId))
                    .fetchSingle().value1(),
            )
            assertEquals(
                listOf(1L),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                    .orderBy(MESSAGES.SEQUENCE)
                    .fetch(MESSAGES.SEQUENCE),
            )
        }

        @Test
        fun `opposite direct sends share the normalized target and transaction`() {
            val left = user("batch-direct-left")
            val right = user("batch-direct-right")

            assertEquals(
                listOf(CommandResult.SAVED, CommandResult.SAVED),
                batches.process(
                    listOf(command(left, newId(), "left", recipient = right), command(right, newId(), "right", recipient = left)),
                ),
            )

            val pair = listOf(left, right).sorted().joinToString(":")
            val chat = db.select(CHATS.ID).from(CHATS).where(CHATS.DIRECT_PAIR_KEY.eq(pair)).fetchSingle().value1()
            assertEquals(
                listOf(1L, 2L),
                db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat))
                    .orderBy(MESSAGES.SEQUENCE)
                    .fetch(MESSAGES.SEQUENCE),
            )
        }

        private fun directChat(sender: String, recipient: String): String = newId().also { chat ->
            db.insertInto(CHATS, CHATS.ID, CHATS.KIND, CHATS.DIRECT_PAIR_KEY)
                .values(chat, ChatKind.DIRECT, listOf(sender, recipient).sorted().joinToString(":"))
                .execute()
            db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID)
                .values(chat, sender)
                .values(chat, recipient)
                .execute()
        }
    }
