package com.andrewtinyakov.messenger.message.pin

import com.andrewtinyakov.messenger.infrastructure.database.generated.Routines
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_PINS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.message.visibility.visibleMessage
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.jooq.Condition
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository

@Repository
class JooqMessagePinRepository(
    private val db: DSLContext,
) : MessagePinRepository {
    override fun lock(chatId: ChatId) = DatabaseObservation.query(DatabaseOperation.MESSAGE_PIN_LOCK) {
        Routines.acquireTransactionLock(db.configuration(), "message-pins:${chatId.value}")
    }

    override fun count(chatId: ChatId, viewerId: UserId?): Int = DatabaseObservation.query(DatabaseOperation.MESSAGE_PIN_COUNT) {
        db.fetchCount(MESSAGE_PINS, MESSAGE_PINS.CHAT_ID.eq(chatId.value).and(scope(viewerId)))
    }

    override fun pin(chatId: ChatId, sequence: Long, viewerId: UserId?): Boolean = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_PIN_WRITE,
    ) {
        db.insertInto(MESSAGE_PINS)
            .set(MESSAGE_PINS.CHAT_ID, chatId.value)
            .set(MESSAGE_PINS.SEQUENCE, sequence)
            .set(MESSAGE_PINS.VIEWER_ID, viewerId?.value)
            .onConflictDoNothing()
            .execute() == 1
    }

    override fun unpin(chatId: ChatId, sequence: Long, viewerId: UserId): Int = DatabaseObservation.query(
        DatabaseOperation.MESSAGE_PIN_WRITE,
    ) {
        db.deleteFrom(MESSAGE_PINS)
            .where(MESSAGE_PINS.CHAT_ID.eq(chatId.value), MESSAGE_PINS.SEQUENCE.eq(sequence), viewable(viewerId))
            .execute()
    }

    override fun unpinAll(chatId: ChatId, viewerId: UserId): Int = DatabaseObservation.query(DatabaseOperation.MESSAGE_PIN_WRITE) {
        db.deleteFrom(MESSAGE_PINS).where(MESSAGE_PINS.CHAT_ID.eq(chatId.value), viewable(viewerId)).execute()
    }

    override fun page(chatId: ChatId, viewerId: UserId, beforeSequence: Long?, limit: Int): List<PinnedMessage> =
        DatabaseObservation.query(DatabaseOperation.MESSAGE_PIN_PAGE) {
            val shared = DSL.boolOr(MESSAGE_PINS.VIEWER_ID.isNull)
            db.select(MESSAGES.ID, MESSAGES.SEQUENCE, shared)
                .from(MESSAGE_PINS)
                .join(MESSAGES).on(MESSAGES.CHAT_ID.eq(MESSAGE_PINS.CHAT_ID), MESSAGES.SEQUENCE.eq(MESSAGE_PINS.SEQUENCE))
                .where(visiblePins(chatId, viewerId))
                .and(beforeSequence?.let { MESSAGE_PINS.SEQUENCE.lt(it) } ?: DSL.trueCondition())
                .groupBy(MESSAGES.ID, MESSAGES.SEQUENCE)
                .orderBy(MESSAGES.SEQUENCE.desc())
                .limit(limit)
                .fetch {
                    PinnedMessage(
                        MessageId(it.value1()!!),
                        it.value2()!!,
                        if (it.value3() ==
                            true
                        ) {
                            PinScope.EVERYONE
                        } else {
                            PinScope.SELF
                        },
                    )
                }
        }

    override fun visibleCount(chatId: ChatId, viewerId: UserId): Int = DatabaseObservation.query(DatabaseOperation.MESSAGE_PIN_COUNT) {
        db.select(DSL.countDistinct(MESSAGE_PINS.SEQUENCE))
            .from(MESSAGE_PINS)
            .join(MESSAGES).on(MESSAGES.CHAT_ID.eq(MESSAGE_PINS.CHAT_ID), MESSAGES.SEQUENCE.eq(MESSAGE_PINS.SEQUENCE))
            .where(visiblePins(chatId, viewerId))
            .fetchOne(0, Int::class.java) ?: 0
    }

    private fun visiblePins(chatId: ChatId, viewerId: UserId): Condition = MESSAGE_PINS.CHAT_ID.eq(chatId.value)
        .and(viewable(viewerId))
        .and(MESSAGES.DELETED_AT.isNull)
        .and(visibleMessage(chatId, viewerId, MESSAGE_PINS.SEQUENCE))

    private fun viewable(viewerId: UserId): Condition = MESSAGE_PINS.VIEWER_ID.isNull.or(MESSAGE_PINS.VIEWER_ID.eq(viewerId.value))

    private fun scope(viewerId: UserId?): Condition = viewerId?.let { MESSAGE_PINS.VIEWER_ID.eq(it.value) } ?: MESSAGE_PINS.VIEWER_ID.isNull
}
