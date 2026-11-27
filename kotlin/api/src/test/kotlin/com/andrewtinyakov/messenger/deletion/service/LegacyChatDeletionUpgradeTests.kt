package com.andrewtinyakov.messenger.deletion.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.JooqUserRepository
import com.andrewtinyakov.messenger.chat.messaging.ChatEventAudience
import com.andrewtinyakov.messenger.chat.messaging.DirectChatOutbox
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.JooqChatRepository
import com.andrewtinyakov.messenger.chat.service.DirectChatService
import com.andrewtinyakov.messenger.deletion.config.HistoryPurgeProperties
import com.andrewtinyakov.messenger.deletion.messaging.DeletionOutbox
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionState
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.monitoring.DeletionMetrics
import com.andrewtinyakov.messenger.deletion.repository.JooqDeletionRepository
import com.andrewtinyakov.messenger.deletion.repository.JooqHistoryPurgeRepository
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.DELETION_OPERATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HISTORY_PURGE_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.SendResultStatus
import com.andrewtinyakov.messenger.infrastructure.database.postgresFunction
import com.andrewtinyakov.messenger.infrastructure.outbox.JooqOutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxWakeup
import com.andrewtinyakov.messenger.message.messaging.MessageSendOutbox
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics
import com.andrewtinyakov.messenger.message.repository.JooqMessageRepository
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.flywaydb.core.Flyway
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.core.env.Environment
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.TransactionAwareDataSourceProxy
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import javax.sql.DataSource

class LegacyChatDeletionUpgradeTests
    @Autowired
    constructor(
        private val source: DataSource,
        private val environment: Environment,
        private val mapper: ObjectMapper,
    ) : MessengerIntegrationTest() {
        @Test
        fun `V6 closed chats upgrade to durable bounded purge without changing active history or send dedup`() {
            val database = "upgrade_${newId().lowercase()}"
            db.createDatabase(DSL.name(database)).execute()
            try {
                val originalUrl = source.connection.use { it.metaData.url }
                val upgradedSource = PGSimpleDataSource().apply {
                    setURL("${originalUrl.substringBeforeLast('/')}/$database")
                    user = environment.getRequiredProperty("spring.datasource.username")
                    password = environment.getRequiredProperty("spring.datasource.password")
                }
                Flyway.configure().dataSource(upgradedSource).target("6").load().migrate()
                val upgradedDb = DSL.using(TransactionAwareDataSourceProxy(upgradedSource), SQLDialect.POSTGRES)
                val owner = newId()
                val member = newId()
                listOf(owner, member).forEach { id ->
                    upgradedDb.insertInto(USERS, USERS.ID, USERS.USERNAME, USERS.PASSWORD_HASH).values(id, id, "x").execute()
                }
                val closedGroup = newId()
                val closedDirect = newId()
                val active = newId()
                upgradedDb.insertInto(CHATS)
                    .set(CHATS.ID, closedGroup)
                    .set(CHATS.KIND, ChatKind.GROUP)
                    .set(CHATS.NAME, "Legacy closed")
                    .set(CHATS.NEXT_SEQUENCE, 1002L)
                    .set(CHATS.OWNER_ID, owner)
                    .set(CHATS.MEMBER_COUNT, 2)
                    .set(CHATS.DELETED_AT, DSL.currentOffsetDateTime())
                    .set(CHATS.DELETED_BY, owner)
                    .execute()
                upgradedDb.insertInto(CHATS)
                    .set(CHATS.ID, closedDirect)
                    .set(CHATS.KIND, ChatKind.DIRECT)
                    .set(CHATS.NEXT_SEQUENCE, 2L)
                    .set(CHATS.MEMBER_COUNT, 2)
                    .set(CHATS.DELETED_AT, DSL.currentOffsetDateTime())
                    .set(CHATS.DELETED_BY, member)
                    .execute()
                upgradedDb.insertInto(CHATS)
                    .set(CHATS.ID, active)
                    .set(CHATS.KIND, ChatKind.GROUP)
                    .set(CHATS.NAME, "Active")
                    .set(CHATS.NEXT_SEQUENCE, 2L)
                    .set(CHATS.OWNER_ID, owner)
                    .set(CHATS.MEMBER_COUNT, 2)
                    .execute()
                listOf(closedGroup, closedDirect, active).forEach { chat ->
                    listOf(owner, member).forEach { user ->
                        upgradedDb.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID).values(chat, user).execute()
                    }
                }
                val body = "legacy retained body"
                val series = DSL.generateSeries(1, 1001).`as`("series", "i")
                val sequence = series.field(0, SQLDataType.INTEGER)!!
                val id = DSL.concat(DSL.inline(closedGroup.take(20)), DSL.lpad(sequence.cast(SQLDataType.VARCHAR), 6, "0"))
                upgradedDb.insertInto(
                    MESSAGES,
                    MESSAGES.ID,
                    MESSAGES.CHAT_ID,
                    MESSAGES.SEQUENCE,
                    MESSAGES.SENDER_ID,
                    MESSAGES.BODY,
                    MESSAGES.CREATED_AT,
                ).select(
                    upgradedDb.select(
                        id,
                        DSL.inline(closedGroup),
                        sequence.cast(SQLDataType.BIGINT),
                        DSL.inline(owner),
                        DSL.inline(body),
                        DSL.currentOffsetDateTime(),
                    ).from(series),
                ).execute()
                upgradedDb.insertInto(
                    MESSAGES,
                    MESSAGES.ID,
                    MESSAGES.CHAT_ID,
                    MESSAGES.SEQUENCE,
                    MESSAGES.SENDER_ID,
                    MESSAGES.BODY,
                    MESSAGES.CREATED_AT,
                ).values(
                    DSL.inline(newId()),
                    DSL.inline(closedDirect),
                    DSL.inline(1L),
                    DSL.inline(owner),
                    DSL.inline(body),
                    DSL.currentOffsetDateTime(),
                ).values(
                    DSL.inline(newId()),
                    DSL.inline(active),
                    DSL.inline(1L),
                    DSL.inline(owner),
                    DSL.inline("active survivor"),
                    DSL.currentOffsetDateTime(),
                ).execute()
                val request = command(owner, newId(), body, chat = closedGroup)
                val messageId = upgradedDb.select(MESSAGES.ID)
                    .from(MESSAGES)
                    .where(MESSAGES.CHAT_ID.eq(closedGroup), MESSAGES.SEQUENCE.eq(1L))
                    .fetchSingle()
                    .value1()!!
                upgradedDb.insertInto(SEND_REQUESTS)
                    .set(SEND_REQUESTS.SENDER_ID, owner)
                    .set(SEND_REQUESTS.REQUEST_ID, request.requestId)
                    .set(SEND_REQUESTS.CHAT_ID, closedGroup)
                    .set(SEND_REQUESTS.FINGERPRINT, sha256("$closedGroup\u0000$owner\u0000$body"))
                    .set(SEND_REQUESTS.STATUS, SendResultStatus.SAVED)
                    .set(SEND_REQUESTS.MESSAGE_ID, messageId)
                    .set(SEND_REQUESTS.SEQUENCE, 1L)
                    .execute()

                fun clearedThrough(chat: String): Long? = upgradedDb.select(CHATS.CLEARED_THROUGH_SEQUENCE)
                    .from(CHATS)
                    .where(CHATS.ID.eq(chat))
                    .fetchSingle()
                    .value1()
                val closedMessages = MESSAGES.CHAT_ID.`in`(closedGroup, closedDirect)

                Flyway.configure().dataSource(upgradedSource).target("8").load().migrate()
                assertEquals(0L, clearedThrough(closedGroup))
                assertEquals(0, upgradedDb.fetchCount(HISTORY_PURGE_JOBS))
                upgradedDb.update(CHATS).set(CHATS.CLEARED_THROUGH_SEQUENCE, 500L).where(CHATS.ID.eq(closedGroup)).execute()
                upgradedDb.insertInto(HISTORY_PURGE_JOBS, HISTORY_PURGE_JOBS.CHAT_ID, HISTORY_PURGE_JOBS.THROUGH_SEQUENCE)
                    .values(closedGroup, 500L)
                    .execute()
                val repeated = RequestId(newId())
                val mutationRevision = DSL.field(DSL.name("mutation_revision"), SQLDataType.BIGINT)
                val visibilityRevision = DSL.field(DSL.name("visibility_revision"), SQLDataType.BIGINT)
                upgradedDb.insertInto(DELETION_OPERATIONS)
                    .set(DELETION_OPERATIONS.ACTOR_ID, owner)
                    .set(DELETION_OPERATIONS.REQUEST_ID, repeated.value)
                    .set(DELETION_OPERATIONS.CHAT_ID, closedGroup)
                    .set(DELETION_OPERATIONS.FINGERPRINT, sha256("$closedGroup|EVERYONE|CHAT|"))
                    .set(DELETION_OPERATIONS.SCOPE, DeletionScope.EVERYONE.name)
                    .set(DELETION_OPERATIONS.TARGET, DeletionTarget.CHAT.name)
                    .set(DELETION_OPERATIONS.THROUGH_SEQUENCE, 1001L)
                    .set(mutationRevision, 0L)
                    .set(visibilityRevision, 0L)
                    .execute()
                Flyway.configure().dataSource(upgradedSource).load().migrate()

                assertEquals(1001L, clearedThrough(closedGroup))
                assertEquals(1L, clearedThrough(closedDirect))
                assertEquals(2, upgradedDb.fetchCount(HISTORY_PURGE_JOBS))
                assertEquals(1002, upgradedDb.fetchCount(MESSAGES, closedMessages))
                assertEquals(0L, clearedThrough(active))
                val tx = TransactionTemplate(DataSourceTransactionManager(upgradedSource))
                val metrics = SimpleMeterRegistry()
                val clock = Clock.systemUTC()
                val messages = JooqMessageRepository(upgradedDb)
                val chats = JooqChatRepository(upgradedDb)
                val outbox = JooqOutboxRepository(upgradedDb, OutboxWakeup(upgradedSource))
                val sends =
                    MessageSendService(
                        messages,
                        chats,
                        DirectChatService(chats, DirectChatOutbox(mapper), JooqUserRepository(upgradedDb)),
                        JooqUserRepository(upgradedDb),
                        MessageSendOutbox(chats, outbox, mapper),
                        tx,
                        clock,
                        MessageSendMetrics(metrics),
                    )
                val deletionMetrics = DeletionMetrics(metrics, clock)
                val deletions =
                    DeletionService(
                        JooqDeletionRepository(upgradedDb, clock),
                        chats,
                        ChatEventAudience(chats),
                        DeletionOutbox(outbox, mapper),
                        tx,
                        deletionMetrics,
                    )
                val worker =
                    HistoryPurgeService(JooqHistoryPurgeRepository(upgradedDb, clock), HistoryPurgeProperties(), tx, deletionMetrics)
                assertNull(
                    messages.findMessage(ChatId(closedGroup), UserId(owner), MessageId(messageId)),
                )
                assertEquals(
                    emptyList<Any>(),
                    messages.findMessagesForPublication(listOf(MessageId(messageId))),
                )
                assertEquals(CommandResult.DUPLICATE, sends.process(request))
                assertEquals("active survivor", messages.findMessagesAfter(ChatId(active), UserId(member), 0, 10).single().body)
                assertEquals(
                    DeletionState.ACCEPTED,
                    deletions.deleteChat(ChatId(closedGroup), UserId(owner), repeated, DeletionScope.EVERYONE).state,
                )

                var batches = 0
                while (upgradedDb.fetchCount(HISTORY_PURGE_JOBS) > 0) {
                    assertTrue(batches++ < 10)
                    val before = upgradedDb.fetchCount(MESSAGES, closedMessages)
                    val removed = worker.runBatch()!!
                    assertTrue(removed in 0..500)
                    val after = upgradedDb.fetchCount(MESSAGES, closedMessages)
                    assertEquals(before - after, removed)
                }
                assertTrue(batches >= 3)
                assertEquals(0, upgradedDb.fetchCount(MESSAGES, closedMessages))
                assertEquals(DeletionState.COMPLETED, deletions.status(ChatId(closedGroup), UserId(owner), repeated).state)
                assertEquals(CommandResult.DUPLICATE, sends.process(request))
                assertEquals(messageId, messages.findSendResult(UserId(owner), RequestId(request.requestId))!!.messageId!!.value)
                assertEquals(1, upgradedDb.fetchCount(SEND_REQUESTS, SEND_REQUESTS.REQUEST_ID.eq(request.requestId)))
                assertEquals("active survivor", messages.findMessagesAfter(ChatId(active), UserId(member), 0, 10).single().body)
                val closedChat = upgradedDb.select(CHATS.DELETED_AT, CHATS.DIRECT_PAIR_KEY)
                    .from(CHATS)
                    .where(CHATS.ID.eq(closedDirect))
                    .fetchSingle()
                assertNotNull(closedChat.value1())
                assertNull(closedChat.value2())
            } finally {
                val activity = DSL.table(DSL.name("pg_catalog", "pg_stat_activity"))
                val datname = DSL.field(DSL.name("datname"), SQLDataType.VARCHAR)
                val pid = DSL.field(DSL.name("pid"), SQLDataType.INTEGER)
                db.select(postgresFunction("pg_terminate_backend", SQLDataType.BOOLEAN, pid, DSL.inline(5000L)))
                    .from(activity)
                    .where(datname.eq(database), pid.ne(postgresFunction("pg_backend_pid", SQLDataType.INTEGER)))
                    .fetch()
                db.dropDatabase(DSL.name(database)).execute()
            }
        }
    }
