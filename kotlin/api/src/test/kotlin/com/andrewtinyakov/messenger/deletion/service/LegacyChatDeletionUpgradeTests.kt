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
import com.andrewtinyakov.messenger.deletion.monitoring.DeletionMetrics
import com.andrewtinyakov.messenger.deletion.repository.JooqDeletionRepository
import com.andrewtinyakov.messenger.deletion.repository.JooqHistoryPurgeRepository
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
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.JdbcTemplate
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
            db.execute("CREATE DATABASE \"$database\"")
            try {
                val originalUrl = source.connection.use { it.metaData.url }
                val upgradedSource = PGSimpleDataSource().apply {
                    setURL("${originalUrl.substringBeforeLast('/')}/$database")
                    user = environment.getRequiredProperty("spring.datasource.username")
                    password = environment.getRequiredProperty("spring.datasource.password")
                }
                Flyway.configure().dataSource(upgradedSource).target("6").load().migrate()
                val sql = JdbcTemplate(upgradedSource)
                val owner = newId()
                val member = newId()
                listOf(owner, member).forEach { sql.update("INSERT INTO users(id,username,password_hash) VALUES (?,?,'x')", it, it) }
                val closedGroup = newId()
                val closedDirect = newId()
                val active = newId()
                sql.update(
                    "INSERT INTO chats(id,kind,name,next_sequence,owner_id,member_count,deleted_at,deleted_by) " +
                        "VALUES (?,'GROUP','Legacy closed',1002,?,2,now(),?)",
                    closedGroup,
                    owner,
                    owner,
                )
                sql.update(
                    "INSERT INTO chats(id,kind,next_sequence,member_count,deleted_at,deleted_by) VALUES (?,'DIRECT',2,2,now(),?)",
                    closedDirect,
                    member,
                )
                sql.update(
                    "INSERT INTO chats(id,kind,name,next_sequence,owner_id,member_count) VALUES (?,'GROUP','Active',2,?,2)",
                    active,
                    owner,
                )
                listOf(closedGroup, closedDirect, active).forEach { chat ->
                    listOf(owner, member).forEach { sql.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?)", chat, it) }
                }
                val body = "legacy retained body"
                sql.update(
                    "INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at) " +
                        "SELECT substr(?::text,1,20)||lpad(i::text,6,'0'),?,i,?,?,now() FROM generate_series(1,1001) i",
                    closedGroup,
                    closedGroup,
                    owner,
                    body,
                )
                sql.update(
                    "INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at) " +
                        "VALUES (?,?,1,?,?,now()),(?,?,1,?,'active survivor',now())",
                    newId(),
                    closedDirect,
                    owner,
                    body,
                    newId(),
                    active,
                    owner,
                )
                val request = command(owner, newId(), body, chat = closedGroup)
                val messageId = sql.queryForObject(
                    "SELECT id FROM messages WHERE chat_id=? AND sequence=1",
                    String::class.java,
                    closedGroup,
                )!!
                sql.update(
                    "INSERT INTO send_requests(sender_id,request_id,chat_id,fingerprint,status,message_id,sequence) " +
                        "VALUES (?,?,?,?,'SAVED',?,1)",
                    owner,
                    request.requestId,
                    closedGroup,
                    sha256("$closedGroup\u0000$owner\u0000$body"),
                    messageId,
                )

                Flyway.configure().dataSource(upgradedSource).target("8").load().migrate()
                assertEquals(0L, sql.queryForObject("SELECT cleared_through_sequence FROM chats WHERE id=?", Long::class.java, closedGroup))
                assertEquals(0, sql.queryForObject("SELECT count(*) FROM history_purge_jobs", Int::class.java))
                sql.update("UPDATE chats SET cleared_through_sequence=500 WHERE id=?", closedGroup)
                sql.update("INSERT INTO history_purge_jobs(chat_id,through_sequence) VALUES (?,500)", closedGroup)
                val repeated = RequestId(newId())
                sql.update(
                    "INSERT INTO deletion_operations(actor_id,request_id,chat_id,fingerprint," +
                        "scope,target,through_sequence,mutation_revision,visibility_revision) " +
                        "VALUES (?,?,?,?,'EVERYONE','CHAT',1001,0,0)",
                    owner,
                    repeated.value,
                    closedGroup,
                    sha256("$closedGroup|EVERYONE|CHAT|"),
                )
                Flyway.configure().dataSource(upgradedSource).load().migrate()

                assertEquals(
                    1001L,
                    sql.queryForObject("SELECT cleared_through_sequence FROM chats WHERE id=?", Long::class.java, closedGroup),
                )
                assertEquals(
                    1L,
                    sql.queryForObject("SELECT cleared_through_sequence FROM chats WHERE id=?", Long::class.java, closedDirect),
                )
                assertEquals(2, sql.queryForObject("SELECT count(*) FROM history_purge_jobs", Int::class.java))
                assertEquals(
                    1002,
                    sql.queryForObject("SELECT count(*) FROM messages WHERE chat_id IN (?,?)", Int::class.java, closedGroup, closedDirect),
                )
                assertEquals(0L, sql.queryForObject("SELECT cleared_through_sequence FROM chats WHERE id=?", Long::class.java, active))
                val jooq = DSL.using(TransactionAwareDataSourceProxy(upgradedSource), SQLDialect.POSTGRES)
                val tx = TransactionTemplate(DataSourceTransactionManager(upgradedSource))
                val metrics = SimpleMeterRegistry()
                val clock = Clock.systemUTC()
                val messages = JooqMessageRepository(jooq)
                val chats = JooqChatRepository(jooq)
                val outbox = JooqOutboxRepository(jooq, OutboxWakeup(upgradedSource))
                val sends =
                    MessageSendService(
                        messages,
                        chats,
                        DirectChatService(chats, DirectChatOutbox(mapper)),
                        JooqUserRepository(jooq),
                        MessageSendOutbox(chats, outbox, mapper),
                        tx,
                        clock,
                        MessageSendMetrics(metrics),
                    )
                val deletionMetrics = DeletionMetrics(metrics, clock)
                val deletions =
                    DeletionService(
                        JooqDeletionRepository(jooq, clock),
                        ChatEventAudience(chats),
                        DeletionOutbox(outbox, mapper),
                        tx,
                        deletionMetrics,
                    )
                val worker = HistoryPurgeService(JooqHistoryPurgeRepository(jooq, clock), HistoryPurgeProperties(), tx, deletionMetrics)
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
                while (sql.queryForObject("SELECT count(*) FROM history_purge_jobs", Int::class.java)!! > 0) {
                    assertTrue(batches++ < 10)
                    val before = sql.queryForObject(
                        "SELECT count(*) FROM messages WHERE chat_id IN (?,?)",
                        Int::class.java,
                        closedGroup,
                        closedDirect,
                    )!!
                    val removed = worker.runBatch()!!
                    assertTrue(removed in 0..500)
                    val after = sql.queryForObject(
                        "SELECT count(*) FROM messages WHERE chat_id IN (?,?)",
                        Int::class.java,
                        closedGroup,
                        closedDirect,
                    )!!
                    assertEquals(before - after, removed)
                }
                assertTrue(batches >= 3)
                assertEquals(
                    0,
                    sql.queryForObject("SELECT count(*) FROM messages WHERE chat_id IN (?,?)", Int::class.java, closedGroup, closedDirect),
                )
                assertEquals(DeletionState.COMPLETED, deletions.status(ChatId(closedGroup), UserId(owner), repeated).state)
                assertEquals(CommandResult.DUPLICATE, sends.process(request))
                assertEquals(messageId, messages.findSendResult(UserId(owner), RequestId(request.requestId))!!.messageId!!.value)
                assertEquals(
                    1,
                    sql.queryForObject("SELECT count(*) FROM send_requests WHERE request_id=?", Int::class.java, request.requestId),
                )
                assertEquals("active survivor", messages.findMessagesAfter(ChatId(active), UserId(member), 0, 10).single().body)
                assertNotNull(
                    sql.queryForObject("SELECT deleted_at FROM chats WHERE id=?", java.time.OffsetDateTime::class.java, closedDirect),
                )
                assertNull(sql.queryForObject("SELECT direct_pair_key FROM chats WHERE id=?", String::class.java, closedDirect))
            } finally {
                db.execute("DROP DATABASE \"$database\" WITH (FORCE)")
            }
        }
    }
