package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.directory.hidden
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.message.model.visibility.HiddenRange
import com.andrewtinyakov.messenger.message.model.visibility.VisibilitySnapshot
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository

@Repository
class JooqMessageVisibilityRepository(
    private val db: DSLContext,
) : MessageVisibilityRepository {
    override fun snapshot(
        chatId: ChatId,
        userId: UserId,
    ): VisibilitySnapshot? =
        db.select(
            CHATS.NEXT_SEQUENCE,
            mutationSeq(chatId),
            CHAT_MEMBERS.VISIBILITY_SEQ,
            CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE,
            CHATS.CLEARED_THROUGH_SEQUENCE,
            DSL.field(hidden(CHAT_MEMBERS)),
        ).from(CHATS).join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .where(CHATS.ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull)
            .fetchOne {
                VisibilitySnapshot(
                    snapshotSequence = it.value1()!! - 1,
                    mutationSeq = it.value2()!!,
                    visibilitySeq = it.value3()!!,
                    clearedThroughSequence = it.value4()!!,
                    globalClearedThroughSequence = it.value5()!!,
                    hidden = it.value6() == true,
                )
            }

    override fun containing(chatId: ChatId, userId: UserId, sequence: Long): HiddenRange? =
        db.selectFrom(HIDDEN_MESSAGE_RANGES)
            .where(
                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
                HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.lt(sequence),
            )
            .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.desc()).limit(1)
            .fetchOne()?.takeIf { it.throughSequence!! >= sequence }?.let { HiddenRange(it.afterSequence!!, it.throughSequence!!) }

    override fun next(chatId: ChatId, userId: UserId, after: Long): HiddenRange? =
        db.selectFrom(HIDDEN_MESSAGE_RANGES)
            .where(
                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
                HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.ge(after),
            )
            .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE).limit(1).fetchOne()?.let {
                HiddenRange(it.afterSequence!!, it.throughSequence!!)
            }

    override fun previous(chatId: ChatId, userId: UserId, before: Long): HiddenRange? =
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
