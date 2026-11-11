package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.model.MemberChat
import com.andrewtinyakov.messenger.chat.model.MemberChatDetails
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

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
            .and(if (pinned) CHAT_MEMBERS.PINNED_RANK.isNotNull else CHAT_MEMBERS.PINNED_RANK.isNull)
            .and(
                if (!pinned && beforeActivityAt != null && beforeChatId != null) {
                    activityAt.lt(beforeActivityAt)
                        .or(
                            activityAt.eq(beforeActivityAt)
                                .and(CHAT_MEMBERS.CHAT_ID.lt(beforeChatId.value)),
                        )
                } else {
                    DSL.trueCondition()
                },
            )
            .orderBy(
                if (pinned) {
                    listOf(CHAT_MEMBERS.PINNED_RANK.asc(), CHAT_MEMBERS.CHAT_ID.desc())
                } else {
                    listOf(activityAt.desc(), CHAT_MEMBERS.CHAT_ID.desc())
                },
            )
            .limit(limit)
            .fetch { row ->
                MemberChat(
                    chat = Chat(
                        id = ChatId(row.get(CHATS.ID)!!),
                        kind = ChatKind.valueOf(row.get(CHATS.KIND)!!.name),
                        name = row.get(CHATS.NAME),
                        lastSequence = row.get(CHATS.NEXT_SEQUENCE)!! - 1,
                        ownerId = row.get(CHATS.OWNER_ID)
                            ?.let(::UserId),
                        memberCount = row.get(CHATS.MEMBER_COUNT)!!,
                        preferences = preferences.read(row),
                    ).withSummary(row.get(summary), row.get(activityAt)),
                    activityAt = row.get(activityAt)!!,
                )
            }
    }

    override fun findMembersByChatIds(chatIds: List<ChatId>): Map<ChatId, List<UserSummary>> = DatabaseObservation.query(
        DatabaseOperation.CHAT_FIND_MEMBERS_BY_CHAT_IDS,
    ) {
        if (chatIds.isEmpty()) return emptyMap()
        val rank = DSL.rowNumber()
            .over()
            .partitionBy(CHAT_MEMBERS.CHAT_ID)
            .orderBy(USERS.USERNAME)
            .`as`("rank")
        val ranked = db.select(
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
                    .le(50),
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
        val members = DSL.multiset(
            DSL.select(
                USERS.ID,
                USERS.USERNAME,
            )
                .from(CHAT_MEMBERS)
                .join(USERS)
                .on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
                .where(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
                .orderBy(CHAT_MEMBERS.USER_ID)
                .limit(50),
        )
            .convertFrom { rows ->
                rows.map {
                    UserSummary(
                        id = UserId(it.value1()!!),
                        username = it.value2()!!,
                    )
                }
            }
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

    override fun findMembers(chatId: ChatId): List<UserSummary> = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_MEMBERS) {
        val preview = db.select(CHAT_MEMBERS.USER_ID)
            .from(CHAT_MEMBERS)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value))
            .orderBy(CHAT_MEMBERS.USER_ID)
            .limit(50)
            .asTable("preview")
        val previewUserId = preview.field(CHAT_MEMBERS.USER_ID)!!
        return db.select(
            USERS.ID,
            USERS.USERNAME,
        )
            .from(preview)
            .join(USERS)
            .on(USERS.ID.eq(previewUserId))
            .orderBy(previewUserId)
            .fetch {
                UserSummary(
                    id = UserId(it.get(USERS.ID)!!),
                    username = it.get(USERS.USERNAME)!!,
                )
            }
    }
}
