package com.andrewtinyakov.messenger.chat.repository.directory

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatLastMessage
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_PROGRESS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.ChatMembers
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import org.jooq.Condition
import org.jooq.Field
import org.jooq.Table
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

internal fun chatSummary(userId: UserId, member: ChatMembers): Field<ChatSummary> {
    val frontier = DSL.field(DSL.name("frontier"), Long::class.java)
    val hasRanges = DSL.field(DSL.name("has_ranges"), Boolean::class.java)
    val viewer = DSL.select(readThrough(userId).`as`(frontier), anyHiddenRange(userId).`as`(hasRanges))
        .offset(0)
        .asTable("summary_viewer")

    val window = DSL.select(MESSAGES.SEQUENCE, MESSAGES.SENDER_ID, MESSAGES.DELETED_AT)
        .from(MESSAGES)
        .where(MESSAGES.CHAT_ID.eq(CHATS.ID))
        .orderBy(MESSAGES.SEQUENCE.desc())
        .limit(Chat.SUMMARY_WINDOW)
        .asTable("summary_window")
    val visible = DSL.field(DSL.name("visible"), Boolean::class.java)
    val candidates = DSL.select(
        window.field(MESSAGES.SEQUENCE),
        window.field(MESSAGES.SENDER_ID),
        DSL.field(visibleCandidate(window, member, viewer.field(hasRanges)!!, userId)).`as`(visible),
    ).from(window).offset(0).asTable("summary_candidates")

    val sequence = candidates.field(MESSAGES.SEQUENCE)!!
    val sender = candidates.field(MESSAGES.SENDER_ID)!!
    val isVisible = candidates.field(visible)!!
    val readThrough = viewer.field(frontier)!!
    val unread = DSL.field(DSL.name("unread"), Int::class.java)
    val capped = DSL.field(DSL.name("capped"), Boolean::class.java)
    val latest = DSL.field(DSL.name("latest"), Long::class.java)
    val counts = DSL.select(
        DSL.count().filterWhere(isVisible.isTrue.and(sender.ne(userId.value)).and(sequence.gt(readThrough))).`as`(unread),
        DSL.field(DSL.count().filterWhere(sequence.gt(readThrough)).eq(Chat.SUMMARY_WINDOW)).`as`(capped),
        DSL.max(sequence).filterWhere(isVisible.isTrue).`as`(latest),
    ).from(candidates).asTable("summary_counts")

    val last = MESSAGES.`as`("summary_last")
    return DSL.multiset(
        DSL.select(
            counts.field(unread),
            counts.field(capped),
            last.ID,
            last.SEQUENCE,
            last.SENDER_ID,
            USERS.USERNAME,
            last.CREATED_AT,
            DSL.left(last.BODY, Message.PREVIEW_LENGTH),
        )
            .from(viewer)
            .crossJoin(DSL.lateral(counts))
            .leftJoin(last).on(last.CHAT_ID.eq(CHATS.ID), last.SEQUENCE.eq(counts.field(latest)))
            .leftJoin(USERS).on(USERS.ID.eq(last.SENDER_ID)),
    ).convertFrom { rows ->
        val row = rows.single()
        ChatSummary(
            unreadCount = row.value1()!!,
            unreadCountCapped = row.value2()!!,
            lastMessage = row.value3()?.let { id ->
                ChatLastMessage(
                    MessageId(id),
                    row.value4()!!,
                    UserId(row.value5()!!),
                    row.value6()!!,
                    row.value7()!!,
                    row.value8()!!,
                    false,
                )
            },
        )
    }
}

private fun readThrough(userId: UserId): Field<Long> = DSL.coalesce(
    DSL.select(CHAT_READ_PROGRESS.THROUGH_SEQUENCE).from(CHAT_READ_PROGRESS)
        .where(CHAT_READ_PROGRESS.CHAT_ID.eq(CHATS.ID), CHAT_READ_PROGRESS.USER_ID.eq(userId.value)).asField<Long>(),
    DSL.inline(0L),
)

private fun anyHiddenRange(userId: UserId): Field<Boolean> = DSL.field(
    DSL.exists(
        DSL.selectOne().from(HIDDEN_MESSAGE_RANGES)
            .where(HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(CHATS.ID), HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value)),
    ),
)

private fun visibleCandidate(window: Table<*>, member: ChatMembers, hasRanges: Field<Boolean>, userId: UserId): Condition {
    val sequence = window.field(MESSAGES.SEQUENCE)!!
    return window.field(MESSAGES.DELETED_AT)!!.isNull
        .and(sequence.gt(DSL.greatest(CHATS.CLEARED_THROUGH_SEQUENCE, member.CLEARED_THROUGH_SEQUENCE)))
        .and(notHidden(member))
        .and(
            hasRanges.isFalse.or(
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
            ),
        )
}
