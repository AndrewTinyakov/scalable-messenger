package com.andrewtinyakov.messenger.deletion.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionState
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.web.payload.DeletionResponse
import com.andrewtinyakov.messenger.infrastructure.database.PostgresExplainFormat
import com.andrewtinyakov.messenger.infrastructure.database.PostgresStatements
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.DELETION_OPERATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HISTORY_PURGE_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_CHANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.service.MessageMutationService
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.message.service.MessageSendStatusService
import com.andrewtinyakov.messenger.message.web.payload.MessageChangeKind
import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.andrewtinyakov.messenger.read.service.ReadService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.jooq.Condition
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus
import java.util.concurrent.TimeUnit
import javax.sql.DataSource

class ScopedDeletionTests
    @Autowired
    constructor(
        private val sends: MessageSendService,
        private val history: MessageHistoryService,
        private val messageSendStatusService: MessageSendStatusService,
        private val deletions: DeletionService,
        private val purge: HistoryPurgeService,
        private val chats: ChatService,
        private val edits: MessageMutationService,
        private val messages: MessageRepository,
        private val reads: ReadService,
        private val source: DataSource,
    ) : MessengerIntegrationTest() {
        @Test
        fun `personal hide is shared account state while other members and quotes retain visibility`() {
            val owner = user("scope-self-owner")
            val member = user("scope-self-member")
            val chat = group(owner, member)
            val first = send(owner, chat, "first")
            sends.process(command(member, newId(), "reply", chat = chat).copy(replyToMessageId = first.id))
            val input = RequestId(newId())
            assertEquals(
                DeletionState.COMPLETED,
                deletions.deleteMessages(ChatId(chat), UserId(owner), input, DeletionScope.SELF, listOf(MessageId(first.id))).state,
            )
            val secondDevice = history.messages(ChatId(chat), UserId(owner), null, null, 100)
            assertEquals(listOf("reply"), secondDevice.messages.map { it.body })
            assertEquals(first.id, secondDevice.messages.single().replyToMessageId)
            assertNull(secondDevice.messages.single().replyBody)
            assertEquals("1", secondDevice.visibilitySeq)
            assertEquals(listOf("first", "reply"), history.messages(ChatId(chat), UserId(member), null, null, 100).messages.map { it.body })
            assertEquals("first", history.messages(ChatId(chat), UserId(member), null, null, 100).messages.last().replyBody)
            assertTrue(history.resolve(ChatId(chat), UserId(owner), listOf(MessageId(first.id))).messages.isEmpty())
            assertNull(messages.findReply(ChatId(chat), UserId(owner), MessageId(first.id)))
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    history.around(ChatId(chat), UserId(owner), MessageId(first.id), null, 10)
                }.status,
            )
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.readers(ChatId(chat), UserId(owner), MessageId(first.id), null, 10)
                }.status,
            )
            assertEquals(
                deletions.deleteMessages(ChatId(chat), UserId(owner), input, DeletionScope.SELF, listOf(MessageId(first.id))),
                deletions.status(ChatId(chat), UserId(owner), input),
            )
            assertEquals(1, db.fetchCount(HIDDEN_MESSAGE_RANGES, HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chat)))
        }

        @Test
        fun `personal clear keeps chat and personal delete resurfaces only after a new saved sequence`() {
            val owner = user("scope-life-owner")
            val member = user("scope-life-member")
            val chat = group(owner, member)
            val first = send(owner, chat, "old")
            delete(chat, member, DeletionScope.SELF, DeletionTarget.HISTORY)
            assertTrue(history.messages(ChatId(chat), UserId(member), null, null, 10).messages.isEmpty())
            assertTrue(chats.list(UserId(member), null, 100).chats.any { it.id == chat })
            delete(chat, member, DeletionScope.SELF, DeletionTarget.CHAT)
            assertTrue(history.visibility(ChatId(chat), UserId(member)).hidden)
            assertFalse(chats.list(UserId(member), null, 100).chats.any { it.id == chat })
            edits.edit(ChatId(chat), UserId(owner), MessageId(first.id), "old edited", 1L)
            assertFalse(chats.list(UserId(member), null, 100).chats.any { it.id == chat })
            send(owner, chat, "new")
            assertTrue(chats.list(UserId(member), null, 100).chats.any { it.id == chat })
            assertFalse(history.visibility(ChatId(chat), UserId(member)).hidden)
            assertEquals(listOf("new"), history.messages(ChatId(chat), UserId(member), null, null, 10).messages.map { it.body })
            assertEquals(0, db.fetchCount(HIDDEN_MESSAGE_RANGES, HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chat)))
        }

        @Test
        fun `everyone delete removes actual rows and old changes and retries cannot resurrect them`() {
            val owner = user("scope-global-owner")
            val member = user("scope-global-member")
            val chat = group(owner, member)
            val request = command(member, newId(), "erasable", chat = chat)
            sends.process(request)
            val target = history.messages(ChatId(chat), UserId(member), null, null, 10).messages.single()
            edits.edit(ChatId(chat), UserId(member), MessageId(target.id), "edited", 1L)
            sends.process(command(owner, newId(), "quote", chat = chat).copy(replyToMessageId = target.id))
            delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, listOf(target.id))
            assertEquals(0, db.fetchCount(MESSAGES, MESSAGES.ID.eq(target.id)))
            val rows = history.messages(ChatId(chat), UserId(member), 0L, null, 100)
            assertEquals(listOf("3"), rows.messages.map { it.sequence })
            assertEquals("4", rows.nextSequence)
            assertFalse(rows.hasMore)
            assertNull(rows.messages.single().replyBody)
            val changes = history.changes(ChatId(chat), UserId(member), 0L, 100)
            assertTrue(changes.changes.all { it.kind == MessageChangeKind.REMOVED && it.message == null && it.messageId == target.id })
            assertEquals(CommandResult.DUPLICATE, sends.process(request))
            assertEquals(target.id, messageSendStatusService.status(UserId(member), RequestId(request.requestId)).messageId)
            assertEquals(1, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
            assertEquals(
                listOf("3"),
                history.around(ChatId(chat), UserId(member), MessageId(target.id), target.sequence.toLong(), 10).messages.map {
                    it.sequence
                },
            )
        }

        @Test
        fun `mixed unauthorized group batch fails atomically while direct peer can delete any author`() {
            val owner = user("scope-right-owner")
            val member = user("scope-right-member")
            val chat = group(owner, member)
            val theirs = send(owner, chat, "theirs")
            val mine = send(member, chat, "mine")
            assertEquals(
                HttpStatus.FORBIDDEN,
                assertThrows(ApiException::class.java) {
                    delete(chat, member, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, listOf(mine.id, theirs.id))
                }.status,
            )
            assertEquals(2, history.messages(ChatId(chat), UserId(member), null, null, 10).messages.size)
            assertEquals("2", history.visibility(ChatId(chat), UserId(member)).snapshotSequence)
            assertEquals(
                HttpStatus.FORBIDDEN,
                assertThrows(ApiException::class.java) {
                    delete(chat, member, DeletionScope.EVERYONE, DeletionTarget.HISTORY)
                }.status,
            )
            val first = command(owner, newId(), "direct", recipient = member)
            sends.process(first)
            val direct = messageSendStatusService.status(UserId(owner), RequestId(first.requestId))
            delete(direct.chatId!!, member, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, listOf(direct.messageId!!))
            assertTrue(history.messages(ChatId(direct.chatId), UserId(owner), null, null, 10).messages.isEmpty())
        }

        @Test
        fun `large clear acceptance is compact and purge advances bounded committed chunks while newer sends survive`() {
            repeat(100) { purge.runBatch() }
            val owner = user("scope-purge-owner")
            val member = user("scope-purge-member")
            val chat = group(owner, member)
            seed(chat, owner, 1201)
            val input = RequestId(newId())
            val accepted = deletions.clearHistory(ChatId(chat), UserId(owner), input, DeletionScope.EVERYONE)
            assertEquals(DeletionState.ACCEPTED, accepted.state)
            assertEquals("1201", accepted.clearedThroughSequence)
            assertEquals(1201, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
            val empty = history.messages(ChatId(chat), UserId(member), 0L, null, 50)
            assertTrue(empty.messages.isEmpty())
            assertEquals("1202", empty.nextSequence)
            assertEquals("1202", empty.coverageThroughSequence)
            assertFalse(empty.hasMore)
            send(owner, chat, "after cutoff")
            assertEquals(500, purge.runBatch())
            assertEquals(701, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat), MESSAGES.SEQUENCE.le(1201L)))
            val workers = List(2) { concurrently { purge.runBatch() } }.map { it.get(10, TimeUnit.SECONDS) }
            assertTrue(workers.filterNotNull().all { it in 0..500 })
            repeat(4) { purge.runBatch() }
            assertEquals(DeletionState.COMPLETED, deletions.status(ChatId(chat), UserId(owner), input).state)
            assertEquals(
                accepted.clearedThroughSequence,
                deletions.clearHistory(ChatId(chat), UserId(owner), input, DeletionScope.EVERYONE).clearedThroughSequence,
            )
            assertEquals(listOf("after cutoff"), history.messages(ChatId(chat), UserId(member), null, null, 50).messages.map { it.body })
            assertEquals(
                1,
                db.fetchCount(MESSAGE_CHANGES, MESSAGE_CHANGES.CHAT_ID.eq(chat), MESSAGE_CHANGES.KIND.eq(MessageChangeKind.CLEARED.name)),
            )
            assertEquals(0, db.fetchCount(HIDDEN_MESSAGE_RANGES, HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chat)))
        }

        @Test
        fun `huge middle exclusion seeks around interval endpoints and alternating exclusions return bounded progressing coverage`() {
            val owner = user("scope-middle-owner")
            val member = user("scope-middle-member")
            val chat = group(owner, member)
            seed(chat, owner, 100000)
            db.insertInto(
                HIDDEN_MESSAGE_RANGES,
                HIDDEN_MESSAGE_RANGES.CHAT_ID,
                HIDDEN_MESSAGE_RANGES.USER_ID,
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE,
                HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE,
            ).values(chat, member, 10L, 99990L)
                .execute()
            source.connection.use { connection ->
                PostgresStatements.execute(connection, PostgresStatements.analyze(MESSAGES))
                PostgresStatements.execute(connection, PostgresStatements.analyze(HIDDEN_MESSAGE_RANGES))
            }
            val page = history.messages(ChatId(chat), UserId(member), 0L, null, 50)
            assertEquals((1L..10L).map(Long::toString) + (99991L..100000L).map(Long::toString), page.messages.map { it.sequence })
            assertEquals("100000", page.nextSequence)
            assertFalse(page.hasMore)
            val backward = history.messages(ChatId(chat), UserId(member), null, null, 50)
            assertEquals(page.messages.map { it.id }, backward.messages.map { it.id })
            val query = db.selectFrom(MESSAGES)
                .where(MESSAGES.CHAT_ID.eq(chat), MESSAGES.SEQUENCE.gt(99990L), MESSAGES.SEQUENCE.le(100000L))
                .orderBy(MESSAGES.SEQUENCE)
                .limit(51)
            val plan = source.connection.use { connection ->
                PostgresStatements.fetchText(connection, PostgresStatements.explainAnalyze(query, PostgresExplainFormat.JSON)).single()
            }
            assertTrue(plan.contains("Index"), plan)
            assertFalse(plan.contains("Rows Removed by Filter"), plan)
            db.deleteFrom(HIDDEN_MESSAGE_RANGES).where(HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chat)).execute()
            val series = DSL.generateSeries(1, 99, 2).`as`("series", "i")
            val sequence = series.field(0, SQLDataType.BIGINT)!!
            db.insertInto(
                HIDDEN_MESSAGE_RANGES,
                HIDDEN_MESSAGE_RANGES.CHAT_ID,
                HIDDEN_MESSAGE_RANGES.USER_ID,
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE,
                HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE,
            ).select(
                db.select(DSL.inline(chat), DSL.inline(member), sequence.minus(1L), sequence).from(series),
            ).execute()
            val bounded = history.messages(ChatId(chat), UserId(member), 0L, null, 50)
            assertTrue(bounded.hasMore)
            assertTrue(bounded.messages.size <= 8)
            assertEquals("16", bounded.nextSequence)
            assertEquals(listOf("2", "4", "6", "8", "10", "12", "14", "16"), bounded.messages.map { it.sequence })
        }

        @Test
        fun `outbox failure rolls back row removal cutoff request result and changes`() {
            val owner = user("scope-rollback-owner")
            val member = user("scope-rollback-member")
            val chat = group(owner, member)
            val first = send(owner, chat, "retained")
            val constraint = DSL.name("reject_${newId()}")
            db.alterTable(MESSENGER_OUTBOX_EVENTS).add(
                DSL.constraint(constraint).check(
                    DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").ne("history_changed")
                        .or(DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "chatId").ne(chat)),
                ),
            ).execute()
            try {
                assertThrows(RuntimeException::class.java) {
                    delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, listOf(first.id))
                }
                assertThrows(RuntimeException::class.java) { delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.HISTORY) }
                assertEquals(listOf("retained"), history.messages(ChatId(chat), UserId(member), null, null, 10).messages.map { it.body })
                assertEquals("1", history.visibility(ChatId(chat), UserId(member)).snapshotSequence)
                assertEquals("0", history.visibility(ChatId(chat), UserId(member)).globalClearedThroughSequence)
                assertEquals(0, db.fetchCount(DELETION_OPERATIONS, DELETION_OPERATIONS.CHAT_ID.eq(chat)))
                assertEquals(0, db.fetchCount(HISTORY_PURGE_JOBS, HISTORY_PURGE_JOBS.CHAT_ID.eq(chat)))
            } finally {
                db.alterTable(MESSENGER_OUTBOX_EVENTS).dropConstraint(constraint).execute()
            }
        }

        @Test
        fun `idempotency conflicts reject changed targets and concurrent personal operations merge adjacent ranges`() {
            val owner = user("scope-merge-owner")
            val member = user("scope-merge-member")
            val chat = group(owner, member)
            val first = send(owner, chat, "one")
            val second = send(owner, chat, "two")
            val attempts = listOf(first, second).map { row ->
                concurrently { delete(chat, member, DeletionScope.SELF, DeletionTarget.MESSAGES, listOf(row.id)) }
            }
            attempts.forEach { it.get(10, TimeUnit.SECONDS) }
            assertEquals(
                1,
                db.fetchCount(
                    HIDDEN_MESSAGE_RANGES,
                    HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chat),
                    HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.eq(0L),
                    HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE.eq(2L),
                ),
            )
            assertEquals("2", history.visibility(ChatId(chat), UserId(member)).visibilitySeq)
            val request = RequestId(newId())
            deletions.clearHistory(ChatId(chat), UserId(owner), request, DeletionScope.SELF)
            assertEquals(
                HttpStatus.CONFLICT,
                assertThrows(ApiException::class.java) {
                    deletions.deleteChat(ChatId(chat), UserId(owner), request, DeletionScope.SELF)
                }.status,
            )
        }

        @Test
        fun `purge failure rolls back content removal and durable progress before a later worker retries`() {
            repeat(100) { purge.runBatch() }
            val owner = user("scope-worker-rollback-owner")
            val member = user("scope-worker-rollback-member")
            val chat = group(owner, member)
            seed(chat, owner, 600)
            val operation = delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.HISTORY)
            val constraint = DSL.name("reject_${newId()}")
            db.alterTable(CHATS).add(DSL.constraint(constraint).check(CHATS.ID.ne(chat).or(CHATS.PURGED_ROWS.eq(0L)))).execute()
            try {
                assertThrows(RuntimeException::class.java) { purge.runBatch() }
                assertEquals(600, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
                assertEquals(0L, db.select(CHATS.PURGED_THROUGH_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
                assertEquals(1, db.fetchCount(HISTORY_PURGE_JOBS, HISTORY_PURGE_JOBS.CHAT_ID.eq(chat)))
            } finally {
                db.alterTable(CHATS).dropConstraint(constraint).execute()
            }
            assertEquals(500, concurrently { purge.runBatch() }.get(10, TimeUnit.SECONDS))
            assertEquals(100, purge.runBatch())
            assertEquals(DeletionState.COMPLETED, deletions.status(ChatId(chat), UserId(owner), RequestId(operation.operationId)).state)
        }

        @Test
        fun `clear and send serialize at the accepted cutoff without deleting a later send`() {
            val owner = user("scope-send-race-owner")
            val member = user("scope-send-race-member")
            repeat(6) {
                val chat = group(owner, member)
                val gate = java.util.concurrent.CountDownLatch(1)
                val command = command(owner, newId(), "racing send", chat = chat)
                val saved = concurrently {
                    gate.await()
                    sends.process(command)
                }
                val cleared = concurrently {
                    gate.await()
                    delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.HISTORY)
                }
                gate.countDown()
                assertEquals(CommandResult.SAVED, saved.get(10, TimeUnit.SECONDS))
                val cutoff = cleared.get(10, TimeUnit.SECONDS).clearedThroughSequence.toLong()
                val sequence = messageSendStatusService.status(UserId(owner), RequestId(command.requestId)).sequence!!.toLong()
                val rows = history.messages(ChatId(chat), UserId(member), 0L, null, 10).messages
                assertEquals(sequence > cutoff, rows.any { it.sequence.toLong() == sequence })
                val fresh = send(owner, chat, "later")
                assertTrue(fresh.sequence.toLong() > cutoff)
            }
        }

        @Test
        fun `direct global deletion still erases a personally hidden target`() {
            val owner = user("scope-redelete-owner")
            val member = user("scope-redelete-member")
            val send = command(owner, newId(), "hide then erase", recipient = member)
            sends.process(send)
            val saved = messageSendStatusService.status(UserId(owner), RequestId(send.requestId))
            val chat = saved.chatId!!
            val target = saved.messageId!!
            delete(chat, member, DeletionScope.SELF, DeletionTarget.MESSAGES, listOf(target))
            assertTrue(history.resolve(ChatId(chat), UserId(member), listOf(MessageId(target))).messages.isEmpty())
            val removed = delete(chat, member, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, listOf(target))
            assertEquals("1", removed.deletedRows)
            assertEquals(0, db.fetchCount(MESSAGES, MESSAGES.ID.eq(target)))
            assertTrue(history.messages(ChatId(chat), UserId(owner), null, null, 10).messages.isEmpty())
        }

        @Test
        fun `a personally hidden foreign author still makes mixed group deletion fail atomically`() {
            val owner = user("scope-hidden-policy-owner")
            val member = user("scope-hidden-policy-member")
            val chat = group(owner, member)
            val mine = send(member, chat, "mine")
            val theirs = send(owner, chat, "theirs")
            delete(chat, member, DeletionScope.SELF, DeletionTarget.MESSAGES, listOf(theirs.id))
            assertEquals(
                HttpStatus.FORBIDDEN,
                assertThrows(ApiException::class.java) {
                    delete(chat, member, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, listOf(mine.id, theirs.id))
                }.status,
            )
            assertEquals(2, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)))
            assertEquals("2", history.visibility(ChatId(chat), UserId(member)).snapshotSequence)
            assertEquals(listOf("mine", "theirs"), history.messages(ChatId(chat), UserId(owner), null, null, 10).messages.map { it.body })
        }

        @Test
        fun `repeating deletion of a legacy closed chat repairs missing purge work once`() {
            repeat(100) { purge.runBatch() }
            val owner = user("scope-legacy-repair-owner")
            val member = user("scope-legacy-repair-member")
            val chat = group(owner, member)
            val row = send(owner, chat, "legacy body")
            db.update(CHATS)
                .set(CHATS.DELETED_AT, DSL.currentOffsetDateTime())
                .set(CHATS.DELETED_BY, owner)
                .where(CHATS.ID.eq(chat))
                .execute()
            val first = RequestId(newId())
            assertEquals(DeletionState.ACCEPTED, deletions.deleteChat(ChatId(chat), UserId(owner), first, DeletionScope.EVERYONE).state)
            assertEquals(1L, db.select(CHATS.CLEARED_THROUGH_SEQUENCE).from(CHATS).where(CHATS.ID.eq(chat)).fetchSingle().value1())
            assertEquals(1, db.fetchCount(HISTORY_PURGE_JOBS, HISTORY_PURGE_JOBS.CHAT_ID.eq(chat)))
            assertEquals(DeletionState.ACCEPTED, deletions.deleteChat(ChatId(chat), UserId(owner), first, DeletionScope.EVERYONE).state)
            delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.CHAT)
            assertEquals(1, db.fetchCount(HISTORY_PURGE_JOBS, HISTORY_PURGE_JOBS.CHAT_ID.eq(chat)))
            assertEquals(1, purge.runBatch())
            assertEquals(0, db.fetchCount(MESSAGES, MESSAGES.ID.eq(row.id)))
            assertEquals(DeletionState.COMPLETED, deletions.status(ChatId(chat), UserId(owner), first).state)
            delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.CHAT)
            assertEquals(0, db.fetchCount(HISTORY_PURGE_JOBS, HISTORY_PURGE_JOBS.CHAT_ID.eq(chat)))
        }

        @Test
        fun `sequence anchor follows certified sparse continuation to the nearest visible survivor`() {
            val owner = user("scope-anchor-spans-owner")
            val member = user("scope-anchor-spans-member")
            val chat = group(owner, member)
            seed(chat, owner, 41)
            val odd = messageIds(chat, MESSAGES.SEQUENCE.le(39L).and(MESSAGES.SEQUENCE.mod(2L).eq(1L)))
            val even = messageIds(chat, MESSAGES.SEQUENCE.le(40L).and(MESSAGES.SEQUENCE.mod(2L).eq(0L)))
            delete(chat, member, DeletionScope.SELF, DeletionTarget.MESSAGES, odd)
            delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, even)
            val first = history.around(ChatId(chat), UserId(member), MessageId(odd.first()), 1L, 50)
            assertNull(first.anchorMessageId)
            assertTrue(first.messages.isEmpty())
            assertFalse(first.hasOlder)
            assertTrue(first.hasNewer)
            assertEquals("0", first.coverageAfterSequence)
            assertEquals("16", first.coverageThroughSequence)
            val middle = history.messages(ChatId(chat), UserId(member), first.coverageThroughSequence.toLong(), null, 50)
            assertTrue(middle.messages.isEmpty())
            assertTrue(middle.hasMore)
            assertEquals("32", middle.nextSequence)
            val survivor = history.messages(ChatId(chat), UserId(member), middle.nextSequence.toLong(), null, 50)
            assertEquals(listOf("41"), survivor.messages.map { it.sequence })
            assertEquals("42", survivor.coverageThroughSequence)
            assertFalse(survivor.hasMore)
        }

        @Test
        fun `non-null around candidate still needs coverage proof before restoring nearest survivor`() {
            val owner = user("scope-anchor-candidate-owner")
            val member = user("scope-anchor-candidate-member")
            val chat = group(owner, member)
            seed(chat, owner, 200)
            val savedId = messageIds(chat, MESSAGES.SEQUENCE.eq(50L)).single()
            val personal = messageIds(chat, MESSAGES.SEQUENCE.between(51L, 69L).and(MESSAGES.SEQUENCE.mod(2L).eq(1L)))
            val everyone = messageIds(
                chat,
                MESSAGES.SEQUENCE.between(2L, 50L)
                    .or(MESSAGES.SEQUENCE.between(52L, 70L).and(MESSAGES.SEQUENCE.mod(2L).eq(0L))),
            )
            assertEquals(59, everyone.size)
            delete(chat, member, DeletionScope.SELF, DeletionTarget.MESSAGES, personal)
            delete(chat, owner, DeletionScope.EVERYONE, DeletionTarget.MESSAGES, everyone)

            val around = history.around(ChatId(chat), UserId(member), MessageId(savedId), 50L, 50)
            assertEquals(listOf("1"), around.messages.map { it.sequence })
            assertEquals(around.messages.single().id, around.anchorMessageId)
            assertEquals("0", around.coverageAfterSequence)
            assertEquals("65", around.coverageThroughSequence)
            assertFalse(around.hasOlder)
            assertTrue(around.hasNewer)

            val next = history.messages(ChatId(chat), UserId(member), around.coverageThroughSequence.toLong(), null, 1)
            assertEquals(listOf("71"), next.messages.map { it.sequence })
            assertEquals("65", next.coverageAfterSequence)
            assertEquals("71", next.coverageThroughSequence)
            assertEquals("71", next.nextSequence)
            assertTrue(next.hasMore)
            assertTrue(next.messages.single().sequence.toLong() - 50 < 50 - around.messages.single().sequence.toLong())
        }

        private fun group(owner: String, member: String): String = chats.createGroup(
            UserId(owner),
            "Scoped deletion",
            listOf(member).map(::UserId),
        ).id

        private fun send(sender: String, chat: String, body: String): MessageResponse {
            sends.process(command(sender, newId(), body, chat = chat))
            return history.messages(ChatId(chat), UserId(sender), null, null, 1).messages.single()
        }

        private fun delete(
            chat: String,
            actor: String,
            scope: DeletionScope,
            target: DeletionTarget,
            ids: List<String>? = null,
        ): DeletionResponse {
            val chatId = ChatId(chat)
            val userId = UserId(actor)
            val requestId = RequestId(newId())
            return when (target) {
                DeletionTarget.MESSAGES -> deletions.deleteMessages(chatId, userId, requestId, scope, ids.orEmpty().map(::MessageId))
                DeletionTarget.HISTORY -> deletions.clearHistory(chatId, userId, requestId, scope)
                DeletionTarget.CHAT -> deletions.deleteChat(chatId, userId, requestId, scope)
            }
        }

        private fun messageIds(chat: String, condition: Condition): List<String> = db.select(MESSAGES.ID)
            .from(MESSAGES)
            .where(MESSAGES.CHAT_ID.eq(chat), condition)
            .orderBy(MESSAGES.SEQUENCE)
            .fetch(MESSAGES.ID)
            .filterNotNull()

        private fun seed(chat: String, sender: String, count: Int) {
            val series = DSL.generateSeries(1, count).`as`("series", "i")
            val sequence = series.field(0, SQLDataType.INTEGER)!!
            val id = DSL.concat(DSL.inline(chat.take(20)), DSL.lpad(sequence.cast(SQLDataType.VARCHAR), 6, "0"))
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
                        id,
                        DSL.inline(chat),
                        sequence.cast(SQLDataType.BIGINT),
                        DSL.inline(sender),
                        DSL.inline("fixture"),
                        DSL.currentOffsetDateTime(),
                    ).from(series),
                ).execute()
            db.update(CHATS).set(CHATS.NEXT_SEQUENCE, count.toLong() + 1).where(CHATS.ID.eq(chat)).execute()
        }
    }
