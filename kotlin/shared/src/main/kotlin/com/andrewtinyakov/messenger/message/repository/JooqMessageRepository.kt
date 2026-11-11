package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.database.generated.Routines
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.MessagesRecord
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.SendRequestsRecord
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.model.SavedMessage
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.model.asReply
import com.andrewtinyakov.messenger.message.visibility.repository.visibleMessage
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.SendRejectionReason as DbSendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.SendResultStatus as DbSendResultStatus

@Repository
class JooqMessageRepository(
    private val db: DSLContext,
) : MessageRepository {
    override fun findMessagesForPublication(
        messageIds: List<MessageId>,
    ): List<Message> = DatabaseObservation.query(DatabaseOperation.MESSAGE_PUBLICATION_HYDRATE) {
        require(messageIds.size <= 100)
        if (messageIds.isEmpty()) return@query emptyList()
        return@query db.select(MESSAGES.asterisk()).from(MESSAGES).join(CHATS).on(CHATS.ID.eq(MESSAGES.CHAT_ID))
            .where(
                MESSAGES.ID.`in`(
                    messageIds.map {
                        it.value
                    },
                ),
                CHATS.DELETED_AT.isNull,
                MESSAGES.SEQUENCE.gt(CHATS.CLEARED_THROUGH_SEQUENCE),
            )
            .fetchInto(MESSAGES).map { it.toModel() }
    }

    override fun findMessagesInSpan(
        chatId: ChatId,
        userId: UserId,
        after: Long,
        through: Long,
        ascending: Boolean,
        limit: Int,
    ): List<Message> = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_VISIBLE_SPAN,
    ) {
        db.selectFrom(
            MESSAGES,
        ).where(
            MESSAGES.CHAT_ID.eq(chatId.value),
            MESSAGES.SEQUENCE.gt(after),
            MESSAGES.SEQUENCE.le(through),
            visibleMessage(chatId, userId, MESSAGES.SEQUENCE),
        )
            .orderBy(if (ascending) MESSAGES.SEQUENCE.asc() else MESSAGES.SEQUENCE.desc()).limit(limit)
            .fetch().let { hydrate(it, userId) }
    }

    override fun lockSend(senderId: UserId, requestId: RequestId) = DatabaseObservation.query(DatabaseOperation.MESSAGE_LOCK_SEND) {
        Routines.acquireTransactionLock(db.configuration(), "send:${senderId.value}:${requestId.value}")
    }

    override fun findSendResult(senderId: UserId, requestId: RequestId): SendResult? = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_FIND_SEND_RESULT,
    ) {
        db.selectFrom(SEND_REQUESTS)
            .where(
                SEND_REQUESTS.SENDER_ID.eq(senderId.value),
                SEND_REQUESTS.REQUEST_ID.eq(requestId.value),
            ).fetchOne()?.toSendResult()
    }

    override fun findSendResults(senderId: UserId, requestIds: List<RequestId>): List<SendResult> = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_FIND_SEND_RESULTS,
    ) {
        if (requestIds.isEmpty()) return emptyList()
        return db.selectFrom(SEND_REQUESTS)
            .where(SEND_REQUESTS.SENDER_ID.eq(senderId.value), SEND_REQUESTS.REQUEST_ID.`in`(requestIds.map { it.value }))
            .fetch { it.toSendResult() }
    }

    override fun insertSendResult(result: SendResult) = DatabaseObservation.query(DatabaseOperation.MESSAGE_INSERT_SEND_RESULT) {
        check(sendResultsInsert(listOf(result)).execute() == 1)
    }

    override fun findSendResults(requests: Map<UserId, List<RequestId>>): List<SendResult> = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_FIND_SEND_RESULTS,
    ) {
        if (requests.isEmpty()) return emptyList()
        return db.selectFrom(SEND_REQUESTS)
            .where(
                DSL.or(
                    requests.map { (sender, ids) ->
                        SEND_REQUESTS.SENDER_ID.eq(sender.value)
                            .and(SEND_REQUESTS.REQUEST_ID.`in`(ids.map(RequestId::value)))
                    },
                ),
            )
            .fetch { it.toSendResult() }
    }

    private fun sendResultsInsert(results: List<SendResult>) = results.fold(
        db.insertInto(
            SEND_REQUESTS,
            SEND_REQUESTS.SENDER_ID,
            SEND_REQUESTS.REQUEST_ID,
            SEND_REQUESTS.CHAT_ID,
            SEND_REQUESTS.RECIPIENT_ID,
            SEND_REQUESTS.FINGERPRINT,
            SEND_REQUESTS.STATUS,
            SEND_REQUESTS.MESSAGE_ID,
            SEND_REQUESTS.SEQUENCE,
            SEND_REQUESTS.REASON,
        ),
    ) { insert, result ->
        insert.values(
            result.senderId.value,
            result.requestId.value,
            result.chatId?.value,
            result.recipientId?.value,
            result.fingerprint,
            DbSendResultStatus.valueOf(result.status.name),
            result.messageId?.value,
            result.sequence,
            result.reason?.let { DbSendRejectionReason.valueOf(it.name) },
        )
    }

    override fun insertSavedMessage(message: Message, result: SendResult) = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_INSERT_SAVED_MESSAGE,
    ) {
        insertSavedMessages(listOf(SavedMessage(message, result)))
    }

    override fun insertSavedMessages(messages: List<SavedMessage>) = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_INSERT_SAVED_MESSAGES,
    ) {
        if (messages.isEmpty()) return@query
        require(messages.size <= 16) { "Saved message batch must contain at most sixteen messages" }
        val messageInsert = db.insertInto(
            MESSAGES,
            MESSAGES.ID,
            MESSAGES.CHAT_ID,
            MESSAGES.SEQUENCE,
            MESSAGES.SENDER_ID,
            MESSAGES.BODY,
            MESSAGES.CREATED_AT,
            MESSAGES.REPLY_TO_MESSAGE_ID,
            MESSAGES.FORWARDED_FROM_USER_ID,
        )
        for ((message, _) in messages) {
            messageInsert.values(
                message.id.value,
                message.chatId.value,
                message.sequence,
                message.senderId.value,
                message.body,
                message.createdAt,
                message.reply?.messageId?.value,
                message.forwardedFromUserId?.value,
            )
        }
        val resultInsert = sendResultsInsert(messages.map { it.result })
        check(db.batch(messageInsert, resultInsert).execute().all { it == messages.size })
    }

    override fun findMessagesAfter(
        chatId: ChatId,
        userId: UserId,
        afterSequence: Long,
        limit: Int,
    ): List<Message> = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_FIND_MESSAGES_AFTER,
    ) {
        db.selectFrom(MESSAGES)
            .where(
                MESSAGES.CHAT_ID.eq(chatId.value),
                MESSAGES.SEQUENCE.gt(afterSequence),
                visibleToMember(chatId = chatId, userId = userId),
            )
            .orderBy(MESSAGES.SEQUENCE)
            .limit(limit)
            .fetch().let { hydrate(it, userId) }
    }

    override fun findMessagesBefore(
        chatId: ChatId,
        userId: UserId,
        beforeSequence: Long?,
        limit: Int,
    ): List<Message> = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_FIND_MESSAGES_BEFORE,
    ) {
        db.selectFrom(MESSAGES)
            .where(MESSAGES.CHAT_ID.eq(chatId.value), visibleToMember(chatId = chatId, userId = userId))
            .and(beforeSequence?.let { MESSAGES.SEQUENCE.lt(it) } ?: DSL.trueCondition())
            .orderBy(MESSAGES.SEQUENCE.desc())
            .limit(limit)
            .fetch().let { hydrate(it, userId) }
    }

    private fun visibleToMember(chatId: ChatId, userId: UserId) = visibleMessage(chatId, userId, MESSAGES.SEQUENCE)

    override fun findMessagesByIds(chatId: ChatId, userId: UserId, messageIds: List<MessageId>): List<Message> =
        DatabaseObservation.query(DatabaseOperation.MESSAGE_FIND_MESSAGES_BY_IDS) {
            require(messageIds.size <= 100)
            if (messageIds.isEmpty()) return@query emptyList()
            db.selectFrom(MESSAGES)
                .where(MESSAGES.CHAT_ID.eq(chatId.value), MESSAGES.ID.`in`(messageIds.map { it.value }), visibleToMember(chatId, userId))
                .fetch().let { hydrate(it, userId) }
        }

    override fun findMessage(chatId: ChatId, userId: UserId, messageId: MessageId): Message? =
        DatabaseObservation.query(DatabaseOperation.MESSAGE_FIND_MESSAGE) {
            db.selectFrom(MESSAGES)
                .where(MESSAGES.CHAT_ID.eq(chatId.value), MESSAGES.ID.eq(messageId.value), visibleToMember(chatId, userId))
                .fetch().let { hydrate(it, userId) }.singleOrNull()
        }

    override fun findReply(chatId: ChatId, userId: UserId, messageId: MessageId): Message? =
        findMessage(chatId, userId, messageId)?.takeIf { it.deletedAt == null }

    private fun hydrate(rows: List<MessagesRecord>, userId: UserId): List<Message> {
        val targets = rows.filter { it.deletedAt == null }.mapNotNull { it.replyToMessageId }.distinct()
        val replies = if (targets.isEmpty()) {
            emptyMap()
        } else {
            db.selectFrom(MESSAGES)
                .where(
                    MESSAGES.ID.`in`(targets),
                    MESSAGES.CHAT_ID.eq(rows.first().chatId),
                    visibleMessage(ChatId(rows.first().chatId!!), userId, MESSAGES.SEQUENCE),
                ).fetch().associateBy {
                    it.id
                }
        }
        return rows.map { row ->
            val parent = if (row.deletedAt == null) replies[row.replyToMessageId] else null
            row.toModel().copy(reply = parent?.toModel()?.asReply())
        }
    }

    private fun MessagesRecord.toModel(): Message =
        Message(
            id = MessageId(id!!),
            chatId = ChatId(chatId!!),
            sequence = sequence!!,
            senderId = UserId(senderId!!),
            body = body!!,
            createdAt = createdAt!!,
            messageVersion = messageVersion!!,
            editedAt = editedAt,
            deletedAt = deletedAt,
            replyToMessageId = replyToMessageId?.let(::MessageId),
            forwardedFromUserId = forwardedFromUserId?.let(::UserId),
        )

    private fun SendRequestsRecord.toSendResult(): SendResult =
        SendResult(
            senderId = UserId(senderId!!),
            requestId = RequestId(requestId!!),
            chatId = chatId?.let(::ChatId),
            recipientId = recipientId?.let(::UserId),
            fingerprint = fingerprint!!,
            status = SendResultStatus.valueOf(status!!.name),
            messageId = messageId?.let(::MessageId),
            sequence = sequence,
            reason = reason?.let { SendRejectionReason.valueOf(it.name) },
        )
}
