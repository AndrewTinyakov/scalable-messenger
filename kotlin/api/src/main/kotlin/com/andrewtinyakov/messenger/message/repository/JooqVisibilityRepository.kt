package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.message.model.HiddenRange
import com.andrewtinyakov.messenger.message.model.VisibilitySnapshot
import org.jooq.DSLContext
import org.springframework.stereotype.Repository

@Repository
class JooqVisibilityRepository(
    private val db: DSLContext,
) : VisibilityRepository {
    override fun snapshot(
        chatId: ChatId,
        userId: UserId,
    ): VisibilitySnapshot? = DatabaseObservation.query(DatabaseOperation.VISIBILITY_SNAPSHOT) {
        db.select(
            CHATS.NEXT_SEQUENCE,
            CHATS.MUTATION_REVISION,
            CHAT_MEMBERS.VISIBILITY_REVISION,
            CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE,
            CHATS.CLEARED_THROUGH_SEQUENCE,
            CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE,
        ).from(CHATS).join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .where(CHATS.ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull)
            .fetchOne {
                val snapshotSequence = it.value1()!! - 1
                VisibilitySnapshot(
                    snapshotSequence,
                    it.value2()!!,
                    it.value3()!!,
                    it.value4()!!,
                    it.value5()!!,
                    it.value6()?.let { cutoff -> snapshotSequence <= cutoff } == true,
                )
            }
    }

    override fun containing(chatId: ChatId, userId: UserId, sequence: Long): HiddenRange? = DatabaseObservation.query(
        DatabaseOperation.VISIBILITY_INTERVAL_SEEK,
    ) {
        db.selectFrom(HIDDEN_MESSAGE_RANGES)
            .where(
                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
                HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.lt(sequence),
            )
            .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.desc()).limit(1)
            .fetchOne()?.takeIf { it.throughSequence!! >= sequence }?.let { HiddenRange(it.afterSequence!!, it.throughSequence!!) }
    }

    override fun next(chatId: ChatId, userId: UserId, after: Long): HiddenRange? = DatabaseObservation.query(
        DatabaseOperation.VISIBILITY_INTERVAL_SEEK,
    ) {
        db.selectFrom(HIDDEN_MESSAGE_RANGES)
            .where(
                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
                HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.ge(after),
            )
            .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE).limit(1).fetchOne()?.let {
                HiddenRange(it.afterSequence!!, it.throughSequence!!)
            }
    }

    override fun previous(chatId: ChatId, userId: UserId, before: Long): HiddenRange? = DatabaseObservation.query(
        DatabaseOperation.VISIBILITY_INTERVAL_SEEK,
    ) {
        db.selectFrom(HIDDEN_MESSAGE_RANGES)
            .where(
                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
                HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE.lt(before),
            )
            .orderBy(HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE.desc()).limit(1).fetchOne()?.let {
                HiddenRange(it.afterSequence!!, it.throughSequence!!)
            }
    }
}
