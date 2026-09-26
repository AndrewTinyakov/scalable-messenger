package com.andrewtinyakov.messenger.conversation

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

data class StoredMessage(
    val id: String,
    val conversationId: String,
    val sequence: Long,
    val senderId: String,
    val body: String,
    val createdAt: OffsetDateTime,
)

data class StoredSendResult(
    val status: String,
    val messageId: String?,
    val sequence: Long?,
    val reason: String?,
)

interface HistoryRepository {
    fun findMessagesAfter(conversationId: String, afterSequence: Long, limit: Int): List<StoredMessage>

    fun findSendResult(conversationId: String, senderId: String, requestId: String): StoredSendResult?
}

@Repository
class JooqHistoryRepository(
    private val db: DSLContext,
) : HistoryRepository {
    override fun findMessagesAfter(conversationId: String, afterSequence: Long, limit: Int): List<StoredMessage> =
        db.selectFrom(MESSAGES)
            .where(MESSAGES.CONVERSATION_ID.eq(conversationId), MESSAGES.SEQUENCE.gt(afterSequence))
            .orderBy(MESSAGES.SEQUENCE)
            .limit(limit)
            .fetch { row ->
                StoredMessage(
                    row.id!!,
                    row.conversationId!!,
                    row.sequence!!,
                    row.senderId!!,
                    row.body!!,
                    row.createdAt!!,
                )
            }

    override fun findSendResult(conversationId: String, senderId: String, requestId: String): StoredSendResult? =
        db.selectFrom(SEND_REQUESTS)
            .where(
                SEND_REQUESTS.CONVERSATION_ID.eq(conversationId),
                SEND_REQUESTS.SENDER_ID.eq(senderId),
                SEND_REQUESTS.REQUEST_ID.eq(requestId),
            ).fetchOne()?.let { StoredSendResult(it.status!!, it.messageId, it.sequence, it.reason) }
}
