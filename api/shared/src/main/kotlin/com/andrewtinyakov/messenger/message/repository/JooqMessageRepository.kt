package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqMessageRepository(
    private val db: DSLContext,
) : MessageRepository {
    override fun lockSend(senderId: String, requestId: String) {
        db.fetch("select pg_advisory_xact_lock(hashtextextended(?, 0))", "send:$senderId:$requestId")
    }

    override fun findSendResult(senderId: String, requestId: String): SendResult? =
        db.selectFrom(SEND_REQUESTS)
            .where(
                SEND_REQUESTS.SENDER_ID.eq(senderId),
                SEND_REQUESTS.REQUEST_ID.eq(requestId),
            ).fetchOne()?.toSendResult()

    override fun findSendResults(senderId: String, requestIds: List<String>): List<SendResult> {
        if (requestIds.isEmpty()) return emptyList()
        return db.selectFrom(SEND_REQUESTS)
            .where(SEND_REQUESTS.SENDER_ID.eq(senderId), SEND_REQUESTS.REQUEST_ID.`in`(requestIds))
            .fetch { it.toSendResult() }
    }

    override fun insertSendResult(result: SendResult) {
        check(
            db.insertInto(SEND_REQUESTS)
                .set(SEND_REQUESTS.SENDER_ID, result.senderId)
                .set(SEND_REQUESTS.REQUEST_ID, result.requestId)
                .set(SEND_REQUESTS.CHAT_ID, result.chatId)
                .set(SEND_REQUESTS.RECIPIENT_ID, result.recipientId)
                .set(SEND_REQUESTS.FINGERPRINT, result.fingerprint)
                .set(SEND_REQUESTS.STATUS, result.status.value)
                .set(SEND_REQUESTS.MESSAGE_ID, result.messageId)
                .set(SEND_REQUESTS.SEQUENCE, result.sequence)
                .set(SEND_REQUESTS.REASON, result.reason)
                .execute() == 1,
        )
    }

    override fun insertMessage(
        id: String,
        chatId: String,
        sequence: Long,
        senderId: String,
        body: String,
        createdAt: OffsetDateTime,
    ) {
        check(
            db.insertInto(MESSAGES)
                .set(MESSAGES.ID, id)
                .set(MESSAGES.CHAT_ID, chatId)
                .set(MESSAGES.SEQUENCE, sequence)
                .set(MESSAGES.SENDER_ID, senderId)
                .set(MESSAGES.BODY, body)
                .set(MESSAGES.CREATED_AT, createdAt)
                .execute() == 1,
        )
    }

    override fun findMessagesAfter(chatId: String, afterSequence: Long, limit: Int): List<Message> =
        db.selectFrom(MESSAGES)
            .where(MESSAGES.CHAT_ID.eq(chatId), MESSAGES.SEQUENCE.gt(afterSequence))
            .orderBy(MESSAGES.SEQUENCE)
            .limit(limit)
            .fetch { row ->
                row.toModel()
            }

    override fun findMessagesBefore(chatId: String, beforeSequence: Long?, limit: Int): List<Message> =
        db.selectFrom(MESSAGES)
            .where(MESSAGES.CHAT_ID.eq(chatId))
            .and(beforeSequence?.let { MESSAGES.SEQUENCE.lt(it) } ?: org.jooq.impl.DSL.trueCondition())
            .orderBy(MESSAGES.SEQUENCE.desc())
            .limit(limit)
            .fetch { it.toModel() }

    private fun com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.MessagesRecord.toModel(): Message =
        Message(id!!, chatId!!, sequence!!, senderId!!, body!!, createdAt!!)

    private fun com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.SendRequestsRecord.toSendResult(): SendResult =
        SendResult(
            senderId = senderId!!,
            requestId = requestId!!,
            chatId = chatId,
            recipientId = recipientId,
            fingerprint = fingerprint!!,
            status = SendResultStatus.valueOf(status!!.uppercase()),
            messageId = messageId,
            sequence = sequence,
            reason = reason,
        )
}
