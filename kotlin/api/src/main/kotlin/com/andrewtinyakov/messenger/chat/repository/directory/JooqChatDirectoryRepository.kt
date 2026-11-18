package com.andrewtinyakov.messenger.chat.repository.directory

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.model.MemberChat
import com.andrewtinyakov.messenger.chat.model.MemberChatDetails
import com.andrewtinyakov.messenger.chat.repository.preferences.ChatPreferenceFields
import com.andrewtinyakov.messenger.chat.repository.toModel
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import org.jooq.Condition
import org.jooq.DSLContext
import org.jooq.Field
import org.jooq.Record
import org.jooq.SortField
import org.jooq.Table
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

private const val MEMBER_PREVIEW_LIMIT = 50

@Repository
class JooqChatDirectoryRepository(
    private val db: DSLContext,
) : ChatDirectoryRepository {
    override fun findByMember(
        userId: UserId,
        beforeActivityAt: OffsetDateTime?,
        beforeChatId: ChatId?,
        limit: Int,
        pinned: Boolean,
    ): List<MemberChat> = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_BY_MEMBER) {
        val summary = chatSummary(userId)
        val activityAt = DSL.coalesce(CHATS.LAST_ACTIVITY_AT, CHAT_MEMBERS.JOINED_AT)
        val preferences = ChatPreferenceFields(CHAT_MEMBERS)
        db.select(
            listOf(
                activityAt,
                summary,
                CHATS.ID,
                CHATS.KIND,
                CHATS.NAME,
                CHATS.NEXT_SEQUENCE,
                CHATS.MEMBER_COUNT,
                CHATS.OWNER_ID,
            ) + preferences.all,
        )
            .from(CHAT_MEMBERS)
            .join(CHATS)
            .on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull)
            .and(notHidden(CHAT_MEMBERS))
            .and(pinState(pinned))
            .and(activityBefore(activityAt, beforeActivityAt, beforeChatId, pinned))
            .orderBy(directoryOrder(activityAt, pinned))
            .limit(limit)
            .fetch { row -> row.toMemberChat(summary, activityAt, preferences) }
    }

    private fun pinState(pinned: Boolean): Condition =
        if (pinned) CHAT_MEMBERS.PINNED_RANK.isNotNull else CHAT_MEMBERS.PINNED_RANK.isNull

    private fun activityBefore(
        activityAt: Field<OffsetDateTime>,
        beforeActivityAt: OffsetDateTime?,
        beforeChatId: ChatId?,
        pinned: Boolean,
    ): Condition = if (!pinned && beforeActivityAt != null && beforeChatId != null) {
        activityAt.lt(beforeActivityAt)
            .or(
                activityAt.eq(beforeActivityAt)
                    .and(CHAT_MEMBERS.CHAT_ID.lt(beforeChatId.value)),
            )
    } else {
        DSL.trueCondition()
    }

    private fun directoryOrder(activityAt: Field<OffsetDateTime>, pinned: Boolean): List<SortField<*>> =
        if (pinned) {
            listOf(CHAT_MEMBERS.PINNED_RANK.asc(), CHAT_MEMBERS.CHAT_ID.desc())
        } else {
            listOf(activityAt.desc(), CHAT_MEMBERS.CHAT_ID.desc())
        }

    private fun Record.toMemberChat(
        summary: Field<ChatSummary>,
        activityAt: Field<OffsetDateTime>,
        preferences: ChatPreferenceFields,
    ): MemberChat = MemberChat(
        chat = Chat(
            id = ChatId(get(CHATS.ID)!!),
            kind = ChatKind.valueOf(get(CHATS.KIND)!!.name),
            name = get(CHATS.NAME),
            lastSequence = get(CHATS.NEXT_SEQUENCE)!! - 1,
            ownerId = get(CHATS.OWNER_ID)
                ?.let(::UserId),
            memberCount = get(CHATS.MEMBER_COUNT)!!,
            preferences = preferences.read(this),
        ).withSummary(get(summary), get(activityAt)),
        activityAt = get(activityAt)!!,
    )

    override fun findMembersByChatIds(chatIds: List<ChatId>): Map<ChatId, List<UserSummary>> = DatabaseObservation.query(
        DatabaseOperation.CHAT_FIND_MEMBERS_BY_CHAT_IDS,
    ) {
        if (chatIds.isEmpty()) return emptyMap()
        val rank = DSL.rowNumber()
            .over()
            .partitionBy(CHAT_MEMBERS.CHAT_ID)
            .orderBy(USERS.USERNAME)
            .`as`("rank")
        val ranked = rankedMembers(chatIds, rank)
        val chatId = ranked.field(CHAT_MEMBERS.CHAT_ID)!!
        val userId = ranked.field(USERS.ID)!!
        val username = ranked.field(USERS.USERNAME)!!
        return db.select(
            chatId,
            userId,
            username,
        )
            .from(ranked)
            .where(
                ranked.field(rank)!!
                    .le(MEMBER_PREVIEW_LIMIT),
            )
            .orderBy(
                chatId,
                username,
            )
            .fetch()
            .groupBy(
                keySelector = { ChatId(it.get(chatId)!!) },
                valueTransform = {
                    UserSummary(
                        id = UserId(it.get(userId)!!),
                        username = it.get(username)!!,
                    )
                },
            )
    }

    private fun rankedMembers(chatIds: List<ChatId>, rank: Field<Int>): Table<*> = db.select(
        CHAT_MEMBERS.CHAT_ID,
        USERS.ID,
        USERS.USERNAME,
        rank,
    )
        .from(CHAT_MEMBERS)
        .join(USERS)
        .on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
        .where(CHAT_MEMBERS.CHAT_ID.`in`(chatIds.map(ChatId::value)))
        .asTable("ranked")

    override fun findById(chatId: ChatId): Chat? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_BY_ID) {
        db.selectFrom(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .fetchOne()
            ?.toModel()
    }

    override fun findMemberDetails(
        chatId: ChatId,
        userId: UserId,
    ): MemberChatDetails? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_MEMBER_DETAILS) {
        val members = memberPreview()
        val summary = chatSummary(userId)
        val viewer = CHAT_MEMBERS.`as`("viewer")
        val preferences = ChatPreferenceFields(viewer)
        val activityAt = DSL.coalesce(CHATS.LAST_ACTIVITY_AT, viewer.JOINED_AT)
        return db.select(
            listOf(
                activityAt,
                CHATS.asterisk(),
                members,
                summary,
            ) + preferences.all,
        )
            .from(CHATS)
            .join(viewer)
            .on(viewer.CHAT_ID.eq(CHATS.ID), viewer.USER_ID.eq(userId.value))
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .fetchOne { row ->
                MemberChatDetails(
                    chat = row.into(CHATS).toModel().copy(preferences = preferences.read(row))
                        .withSummary(row.get(summary), row.get(activityAt)),
                    members = row.get(members),
                )
            }
    }

    private fun memberPreview(): Field<List<UserSummary>> = DSL.multiset(
        DSL.select(
            USERS.ID,
            USERS.USERNAME,
        )
            .from(CHAT_MEMBERS)
            .join(USERS)
            .on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
            .where(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .orderBy(CHAT_MEMBERS.USER_ID)
            .limit(MEMBER_PREVIEW_LIMIT),
    )
        .convertFrom { rows ->
            rows.map {
                UserSummary(
                    id = UserId(it.value1()!!),
                    username = it.value2()!!,
                )
            }
        }
}
