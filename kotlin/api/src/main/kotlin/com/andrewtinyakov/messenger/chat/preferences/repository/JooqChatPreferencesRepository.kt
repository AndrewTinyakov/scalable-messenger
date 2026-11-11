package com.andrewtinyakov.messenger.chat.preferences.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.chat.preferences.model.MuteEnd
import com.andrewtinyakov.messenger.chat.repository.ChatPreferenceFields
import com.andrewtinyakov.messenger.chat.repository.PERMANENT_MUTE
import com.andrewtinyakov.messenger.infrastructure.database.generated.Routines
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.ChatMembersRecord
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import org.jooq.Condition
import org.jooq.DSLContext
import org.jooq.Field
import org.jooq.UpdateSetFirstStep
import org.jooq.UpdateSetMoreStep
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqChatPreferencesRepository(
    private val db: DSLContext,
) : ChatPreferencesRepository {
    override fun lockPins(userId: UserId) = DatabaseObservation.query(DatabaseOperation.CHAT_PREFERENCES_LOCK) {
        Routines.acquireTransactionLock(db.configuration(), "chat-pins:${userId.value}")
    }

    override fun isVisibleMember(chatId: ChatId, userId: UserId): Boolean = DatabaseObservation.query(
        DatabaseOperation.CHAT_PREFERENCES_FIND,
    ) {
        db.fetchExists(
            db.selectOne().from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
                .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value), visibleInDirectory()),
        )
    }

    override fun pinnedChatIds(userId: UserId): List<ChatId> = DatabaseObservation.query(DatabaseOperation.CHAT_PREFERENCES_PINNED) {
        db.select(CHAT_MEMBERS.CHAT_ID).from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.USER_ID.eq(userId.value), CHAT_MEMBERS.PINNED_RANK.isNotNull, visibleInDirectory())
            .orderBy(CHAT_MEMBERS.PINNED_RANK, CHAT_MEMBERS.CHAT_ID.desc())
            .fetch(CHAT_MEMBERS.CHAT_ID)
            .map { ChatId(it!!) }
    }

    override fun replacePinnedOrder(userId: UserId, order: List<ChatId>) = DatabaseObservation.query(
        DatabaseOperation.CHAT_PREFERENCES_WRITE,
    ) {
        require(order.size <= ChatPreferences.MAX_PINNED_CHATS && order.distinct() == order)
        db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.PINNED_RANK, DSL.inline(null, CHAT_MEMBERS.PINNED_RANK))
            .where(CHAT_MEMBERS.USER_ID.eq(userId.value), CHAT_MEMBERS.PINNED_RANK.isNotNull)
            .and(CHAT_MEMBERS.CHAT_ID.notIn(order.map(ChatId::value)))
            .execute()
        if (order.isEmpty()) return@query
        val ranks = order.mapIndexed { index, chatId ->
            db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.PINNED_RANK, (index + 1).toShort())
                .where(CHAT_MEMBERS.USER_ID.eq(userId.value), CHAT_MEMBERS.CHAT_ID.eq(chatId.value))
        }
        check(db.batch(ranks).execute().all { it == 1 }) { "Pinned chat membership changed during reordering" }
    }

    override fun mute(chatId: ChatId, userId: UserId, end: MuteEnd?): Boolean = DatabaseObservation.query(
        DatabaseOperation.CHAT_PREFERENCES_WRITE,
    ) {
        val until: Field<OffsetDateTime> = when (end) {
            null -> DSL.inline(null, CHAT_MEMBERS.MUTED_UNTIL)
            MuteEnd.Forever -> PERMANENT_MUTE
            is MuteEnd.At -> DSL.`val`(end.until)
        }
        updateActiveMember(chatId, userId) { it.set(CHAT_MEMBERS.MUTED_UNTIL, until) }
    }

    override fun markUnread(chatId: ChatId, userId: UserId, at: OffsetDateTime?): Boolean = DatabaseObservation.query(
        DatabaseOperation.CHAT_PREFERENCES_WRITE,
    ) {
        updateActiveMember(chatId, userId) { it.set(CHAT_MEMBERS.MARKED_UNREAD_AT, at) }
    }

    override fun find(chatId: ChatId, userId: UserId): ChatPreferences? = DatabaseObservation.query(
        DatabaseOperation.CHAT_PREFERENCES_FIND,
    ) {
        val fields = ChatPreferenceFields(CHAT_MEMBERS)
        db.select(fields.all).from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull)
            .fetchOne { fields.read(it) }
    }

    private fun updateActiveMember(
        chatId: ChatId,
        userId: UserId,
        change: (UpdateSetFirstStep<ChatMembersRecord>) -> UpdateSetMoreStep<ChatMembersRecord>,
    ): Boolean = change(db.update(CHAT_MEMBERS))
        .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value))
        .andExists(db.selectOne().from(CHATS).where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull))
        .execute() == 1

    private fun visibleInDirectory(): Condition = CHATS.DELETED_AT.isNull.and(
        CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE.isNull.or(CHATS.NEXT_SEQUENCE.minus(1L).gt(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE)),
    )
}
