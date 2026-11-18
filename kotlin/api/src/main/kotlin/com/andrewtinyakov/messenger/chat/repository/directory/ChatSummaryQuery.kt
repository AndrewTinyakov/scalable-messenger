package com.andrewtinyakov.messenger.chat.repository.directory

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatLastMessage
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_PROGRESS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import org.jooq.CommonTableExpression
import org.jooq.Condition
import org.jooq.Field
import org.jooq.impl.DSL
import java.time.OffsetDateTime

internal data class ChatSummary(
    val unreadCount: Int,
    val unreadCountCapped: Boolean,
    val lastMessage: ChatLastMessage?,
)

internal fun Chat.withSummary(summary: ChatSummary, activityAt: OffsetDateTime?): Chat =
    copy(
        activityAt = activityAt,
        lastMessage = summary.lastMessage,
        unreadCount = summary.unreadCount,
        unreadCountCapped = summary.unreadCountCapped,
    )

internal fun chatSummary(userId: UserId): Field<ChatSummary> {
    val candidates = summaryCandidates()
    val sequence = candidates.field(MESSAGES.SEQUENCE)!!
    val sender = candidates.field(MESSAGES.SENDER_ID)!!
    val readThrough = readThrough(userId)
    val visible = visibleCandidate(candidates, userId)
    val last = lastVisibleMessage(candidates, visible)
    return DSL.multiset(
        DSL.with(candidates).select(
            DSL.count().filterWhere(visible.and(sender.ne(userId.value)).and(sequence.gt(readThrough))),
            DSL.count().filterWhere(sequence.gt(readThrough)).eq(Chat.SUMMARY_WINDOW),
            last,
        ).from(candidates),
    ).convertFrom { rows -> rows.single().let { ChatSummary(it.value1(), it.value2(), it.value3()) } }
}

private fun summaryCandidates(): CommonTableExpression<*> = DSL.name("summary_candidates").asMaterialized(
    DSL.select(MESSAGES.ID, MESSAGES.SEQUENCE, MESSAGES.SENDER_ID, MESSAGES.CREATED_AT, MESSAGES.BODY, MESSAGES.DELETED_AT)
        .from(MESSAGES).where(MESSAGES.CHAT_ID.eq(CHATS.ID))
        .orderBy(MESSAGES.SEQUENCE.desc()).limit(Chat.SUMMARY_WINDOW),
)

private fun readThrough(userId: UserId): Field<Long> = DSL.coalesce(
    DSL.select(CHAT_READ_PROGRESS.THROUGH_SEQUENCE).from(CHAT_READ_PROGRESS)
        .where(CHAT_READ_PROGRESS.CHAT_ID.eq(CHATS.ID), CHAT_READ_PROGRESS.USER_ID.eq(userId.value)).asField<Long>(),
    DSL.inline(0L),
)

private fun visibleCandidate(candidates: CommonTableExpression<*>, userId: UserId): Condition {
    val sequence = candidates.field(MESSAGES.SEQUENCE)!!
    return candidates.field(MESSAGES.DELETED_AT)!!.isNull.and(
        DSL.exists(
            DSL.selectOne().from(CHAT_MEMBERS).where(
                CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID),
                CHAT_MEMBERS.USER_ID.eq(userId.value),
                sequence.gt(CHATS.CLEARED_THROUGH_SEQUENCE),
                sequence.gt(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE),
                notHidden(CHAT_MEMBERS),
            ),
        ),
    ).and(
        sequence.gt(
            DSL.coalesce(
                DSL.select(HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE).from(HIDDEN_MESSAGE_RANGES)
                    .where(
                        HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(CHATS.ID),
                        HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                        HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.lt(sequence),
                    )
                    .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.desc()).limit(1).asField<Long>(),
                DSL.inline(0L),
            ),
        ),
    )
}

private fun lastVisibleMessage(candidates: CommonTableExpression<*>, visible: Condition): Field<ChatLastMessage?> {
    val sequence = candidates.field(MESSAGES.SEQUENCE)!!
    val sender = candidates.field(MESSAGES.SENDER_ID)!!
    return DSL.multiset(
        DSL.select(
            candidates.field(MESSAGES.ID),
            sequence,
            sender,
            USERS.USERNAME,
            candidates.field(MESSAGES.CREATED_AT),
            DSL.left(candidates.field(MESSAGES.BODY), Message.PREVIEW_LENGTH),
        )
            .from(candidates).join(USERS).on(USERS.ID.eq(sender)).where(visible).orderBy(sequence.desc()).limit(1),
    ).convertFrom { rows ->
        rows.firstOrNull()?.let {
            ChatLastMessage(
                MessageId(it.value1()!!),
                it.value2()!!,
                UserId(it.value3()!!),
                it.value4()!!,
                it.value5()!!,
                it.value6()!!,
                false,
            )
        }
    }
}
