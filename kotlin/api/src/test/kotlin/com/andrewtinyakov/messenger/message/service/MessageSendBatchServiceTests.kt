package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.MeterRegistry
import org.jooq.DSLContext
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.impl.DefaultExecuteListenerProvider
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
        private val queries: DSLContext,
        private val chats: ChatRepository,
    ) : MessengerIntegrationTest() {
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
            assertEquals(1L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
            assertEquals(
                1L,
                transactions.execute {
                    chats.allocateSequencesForMembers(ChatId(chat), listOf(UserId(sender), UserId(sender), UserId(recipient)))
                },
            )
            assertEquals(4L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
        }

        @Test
        fun `full batch bounds SQL round trips while retaining every durable result`() {
            val sender = user("batch-round-trips-sender")
            val recipient = user("batch-round-trips-recipient")
            val chat = directChat(sender, recipient)
            val commands = (1..16).map { command(sender, newId(), "message $it", chat = chat) }
            val statements = AtomicInteger()
            val previous = queries.configuration().executeListenerProviders()
            val listener = object : ExecuteListener {
                override fun executeStart(context: ExecuteContext) {
                    statements.incrementAndGet()
                }
            }
            queries.configuration().set(*previous, DefaultExecuteListenerProvider(listener))
            try {
                assertEquals(List(16) { CommandResult.SAVED }, batches.process(commands))
            } finally {
                queries.configuration().set(*previous)
            }

            assertTrue(statements.get() in 1..30, "Expected one to 30 SQL executions, observed ${statements.get()}")
            assertEquals(
                (1L..16L).toList(),
                db.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
            )
            assertEquals(16, db.queryForObject("SELECT count(*) FROM send_requests WHERE chat_id=?", Int::class.java, chat))
            assertEquals(
                32,
                db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?", Int::class.java, chat),
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
                db.queryForList("SELECT body FROM messages WHERE chat_id=? ORDER BY sequence", String::class.java, chat),
            )
            assertEquals(2, db.queryForObject("SELECT count(*) FROM send_requests WHERE chat_id=?", Int::class.java, chat))
            assertEquals(3L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
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
                db.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
            )
            assertEquals(3L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
            assertEquals(
                1,
                db.queryForObject(
                    """
                    SELECT count(DISTINCT transaction_id) FROM (
                        SELECT xmin::text AS transaction_id FROM messages WHERE chat_id=?
                        UNION ALL SELECT xmin::text FROM send_requests WHERE chat_id=?
                        UNION ALL SELECT xmin::text FROM messenger_outbox_events WHERE payload->>'chatId'=?
                    ) writes
                    """.trimIndent(),
                    Int::class.java,
                    chat,
                    chat,
                    chat,
                ),
            )
        }

        @Test
        fun `failure in a later command rolls back earlier batch writes`() {
            val sender = user("batch-failure-sender")
            val recipient = user("batch-failure-recipient")
            val chat = directChat(sender, recipient)
            val failingRequest = newId()
            val commands = listOf(command(sender, newId(), "first", chat = chat), command(sender, failingRequest, "fails", chat = chat))
            val constraint = "reject_${newId()}"
            db.execute("ALTER TABLE send_requests ADD CONSTRAINT \"$constraint\" CHECK (request_id <> '$failingRequest')")
            try {
                assertThrows(RuntimeException::class.java) { batches.process(commands) }
                assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE chat_id=?", Int::class.java, chat))
                assertEquals(0, db.queryForObject("SELECT count(*) FROM send_requests WHERE chat_id=?", Int::class.java, chat))
                assertEquals(
                    0,
                    db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?", Int::class.java, chat),
                )
                assertEquals(1L, db.queryForObject("SELECT next_sequence FROM chats WHERE id=?", Long::class.java, chat))
            } finally {
                db.execute("ALTER TABLE send_requests DROP CONSTRAINT \"$constraint\"")
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
                db.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
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
                "NOT_A_MEMBER",
                db.queryForObject("SELECT reason FROM send_requests WHERE request_id=?", String::class.java, rejected.requestId),
            )
            assertEquals(
                listOf(1L, 2L),
                db.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
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
                "EMPTY_BODY",
                db.queryForObject("SELECT reason FROM send_requests WHERE request_id=?", String::class.java, blank.requestId),
            )
            assertEquals(
                "BODY_TOO_LONG",
                db.queryForObject("SELECT reason FROM send_requests WHERE request_id=?", String::class.java, oversized.requestId),
            )
            assertEquals(
                "INVALID_RECIPIENT",
                db.queryForObject("SELECT reason FROM send_requests WHERE request_id=?", String::class.java, self.requestId),
            )
            assertEquals(
                listOf(1L),
                db.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
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
            val chat = db.queryForObject("SELECT id FROM chats WHERE direct_pair_key=?", String::class.java, pair)!!
            assertEquals(
                listOf(1L, 2L),
                db.queryForList("SELECT sequence FROM messages WHERE chat_id=? ORDER BY sequence", Long::class.java, chat),
            )
        }

        private fun directChat(sender: String, recipient: String): String = newId().also { chat ->
            db.update(
                "INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)",
                chat,
                listOf(sender, recipient).sorted().joinToString(":"),
            )
            db.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?),(?,?)", chat, sender, chat, recipient)
        }
    }
