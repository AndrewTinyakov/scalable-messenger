package com.andrewtinyakov.messenger.messaging

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CONVERSATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CONVERSATION_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import org.jooq.DSLContext
import org.jooq.JSONB
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

data class ExistingSend(
    val fingerprint: String,
    val status: String,
)

interface SendRepository {
    fun lockConversation(conversationId: String): String?

    fun findRequest(conversationId: String, senderId: String, requestId: String): ExistingSend?

    fun isMember(conversationId: String, userId: String): Boolean

    fun insertRejected(conversationId: String, senderId: String, requestId: String, fingerprint: String, reason: String): Boolean

    fun allocateSequence(conversationId: String): Long

    fun insertMessage(id: String, conversationId: String, sequence: Long, senderId: String, body: String, createdAt: OffsetDateTime)

    fun insertSaved(conversationId: String, senderId: String, requestId: String, fingerprint: String, messageId: String, sequence: Long)

    fun memberIds(conversationId: String): List<String>

    fun enqueue(eventId: String, room: String, payload: String)
}

@Repository
class JooqSendRepository(
    private val db: DSLContext,
) : SendRepository {
    override fun lockConversation(conversationId: String): String? =
        db.selectFrom(CONVERSATIONS)
            .where(CONVERSATIONS.ID.eq(conversationId))
            .forUpdate()
            .fetchOne()?.kind

    override fun findRequest(conversationId: String, senderId: String, requestId: String): ExistingSend? =
        db.selectFrom(SEND_REQUESTS)
            .where(
                SEND_REQUESTS.CONVERSATION_ID.eq(conversationId),
                SEND_REQUESTS.SENDER_ID.eq(senderId),
                SEND_REQUESTS.REQUEST_ID.eq(requestId),
            ).fetchOne()?.let { ExistingSend(it.fingerprint!!, it.status!!) }

    override fun isMember(conversationId: String, userId: String): Boolean =
        db.fetchExists(
            db.selectOne().from(CONVERSATION_MEMBERS).where(
                CONVERSATION_MEMBERS.CONVERSATION_ID.eq(conversationId),
                CONVERSATION_MEMBERS.USER_ID.eq(userId),
            ),
        )

    override fun insertRejected(conversationId: String, senderId: String, requestId: String, fingerprint: String, reason: String): Boolean =
        db.insertInto(SEND_REQUESTS)
            .set(SEND_REQUESTS.CONVERSATION_ID, conversationId)
            .set(SEND_REQUESTS.SENDER_ID, senderId)
            .set(SEND_REQUESTS.REQUEST_ID, requestId)
            .set(SEND_REQUESTS.FINGERPRINT, fingerprint)
            .set(SEND_REQUESTS.STATUS, "rejected")
            .set(SEND_REQUESTS.REASON, reason)
            .onConflictDoNothing()
            .execute() == 1

    override fun allocateSequence(conversationId: String): Long =
        db.update(CONVERSATIONS)
            .set(CONVERSATIONS.NEXT_SEQUENCE, CONVERSATIONS.NEXT_SEQUENCE.plus(1L))
            .where(CONVERSATIONS.ID.eq(conversationId))
            .returning(CONVERSATIONS.NEXT_SEQUENCE)
            .fetchOne()?.nextSequence?.minus(1L)
            ?: error("Conversation disappeared while allocating sequence")

    override fun insertMessage(
        id: String,
        conversationId: String,
        sequence: Long,
        senderId: String,
        body: String,
        createdAt: OffsetDateTime,
    ) {
        check(
            db.insertInto(MESSAGES)
                .set(MESSAGES.ID, id)
                .set(MESSAGES.CONVERSATION_ID, conversationId)
                .set(MESSAGES.SEQUENCE, sequence)
                .set(MESSAGES.SENDER_ID, senderId)
                .set(MESSAGES.BODY, body)
                .set(MESSAGES.CREATED_AT, createdAt)
                .execute() == 1,
        )
    }

    override fun insertSaved(
        conversationId: String,
        senderId: String,
        requestId: String,
        fingerprint: String,
        messageId: String,
        sequence: Long,
    ) {
        check(
            db.insertInto(SEND_REQUESTS)
                .set(SEND_REQUESTS.CONVERSATION_ID, conversationId)
                .set(SEND_REQUESTS.SENDER_ID, senderId)
                .set(SEND_REQUESTS.REQUEST_ID, requestId)
                .set(SEND_REQUESTS.FINGERPRINT, fingerprint)
                .set(SEND_REQUESTS.STATUS, "saved")
                .set(SEND_REQUESTS.MESSAGE_ID, messageId)
                .set(SEND_REQUESTS.SEQUENCE, sequence)
                .execute() == 1,
        )
    }

    override fun memberIds(conversationId: String): List<String> =
        db.select(CONVERSATION_MEMBERS.USER_ID)
            .from(CONVERSATION_MEMBERS)
            .where(CONVERSATION_MEMBERS.CONVERSATION_ID.eq(conversationId))
            .fetch(CONVERSATION_MEMBERS.USER_ID)

    override fun enqueue(eventId: String, room: String, payload: String) {
        check(
            db.insertInto(OUTBOX_EVENTS)
                .set(OUTBOX_EVENTS.ID, eventId)
                .set(OUTBOX_EVENTS.ROOM, room)
                .set(OUTBOX_EVENTS.PAYLOAD, JSONB.valueOf(payload))
                .execute() == 1,
        )
    }
}
