package com.andrewtinyakov.messenger.chat.repository.membership

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind as DbChatKind

private const val INSERT_CHUNK_SIZE = 500

@Repository
class JooqGroupMembershipRepository(
    private val db: DSLContext,
) : GroupMembershipRepository {
    override fun lockUsers(userIds: List<UserId>): Set<UserId> = DatabaseObservation.query(DatabaseOperation.CHAT_LOCK_USERS) {
        db.select(USERS.ID)
            .from(USERS)
            .where(USERS.ID.`in`(userIds.map(UserId::value)))
            .orderBy(USERS.ID)
            .forNoKeyUpdate()
            .fetch(USERS.ID)
            .map { UserId(requireNotNull(it)) }
            .toSet()
    }

    override fun groupCountsByUser(userIds: List<UserId>): Map<UserId, Int> = DatabaseObservation.query(
        DatabaseOperation.CHAT_GROUP_COUNTS_BY_USER,
    ) {
        db.select(
            CHAT_MEMBERS.USER_ID,
            DSL.count(),
        )
            .from(CHAT_MEMBERS)
            .join(CHATS)
            .on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(
                CHAT_MEMBERS.USER_ID.`in`(userIds.map(UserId::value)),
                CHATS.KIND.eq(DbChatKind.GROUP),
                CHATS.DELETED_AT.isNull,
            )
            .groupBy(CHAT_MEMBERS.USER_ID)
            .fetchMap(
                CHAT_MEMBERS.USER_ID,
                DSL.count(),
            )
            .mapKeys { (userId, _) -> UserId(userId!!) }
    }

    override fun insertMembersAndIncrementCount(
        chatId: ChatId,
        userIds: List<UserId>,
    ) = DatabaseObservation.query(DatabaseOperation.CHAT_INSERT_MEMBERS_AND_INCREMENT_COUNT) {
        if (userIds.isEmpty()) return@query
        userIds.chunked(INSERT_CHUNK_SIZE)
            .forEach { chunk ->
                val insert = db.insertInto(
                    CHAT_MEMBERS,
                    CHAT_MEMBERS.CHAT_ID,
                    CHAT_MEMBERS.USER_ID,
                )
                chunk.forEach {
                    insert.values(
                        chatId.value,
                        it.value,
                    )
                }
                check(insert.execute() == chunk.size)
            }
        val updated = db.update(CHATS)
            .set(
                CHATS.MEMBER_COUNT,
                CHATS.MEMBER_COUNT.plus(userIds.size),
            )
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .execute()
        check(updated == 1)
    }

    override fun findGroupMemberPage(
        chatId: ChatId,
        viewerId: UserId,
        afterUserId: UserId?,
        limit: Int,
    ): List<UserSummary>? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_GROUP_MEMBER_PAGE) {
        val members = DSL.multiset(
            DSL.select(USERS.ID, USERS.USERNAME)
                .from(CHAT_MEMBERS)
                .join(USERS)
                .on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
                .where(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
                .and(afterUserId?.let { CHAT_MEMBERS.USER_ID.gt(it.value) } ?: DSL.trueCondition())
                .orderBy(CHAT_MEMBERS.USER_ID)
                .limit(limit),
        ).convertFrom { rows ->
            rows.map { UserSummary(id = UserId(it.value1()!!), username = it.value2()!!) }
        }
        return db.select(members)
            .from(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.KIND.eq(DbChatKind.GROUP), CHATS.DELETED_AT.isNull)
            .and(
                DSL.exists(
                    DSL.selectOne()
                        .from(CHAT_MEMBERS)
                        .where(
                            CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID),
                            CHAT_MEMBERS.USER_ID.eq(viewerId.value),
                        ),
                ),
            )
            .fetchOne { it.get(members) }
    }

    override fun deleteMemberAndDecrementCount(
        chatId: ChatId,
        userId: UserId,
    ): Boolean = DatabaseObservation.query(DatabaseOperation.CHAT_DELETE_MEMBER_AND_DECREMENT_COUNT) {
        val removed = DSL.name("removed")
            .`as`(
                db.deleteFrom(CHAT_MEMBERS)
                    .where(
                        CHAT_MEMBERS.CHAT_ID.eq(chatId.value),
                        CHAT_MEMBERS.USER_ID.eq(userId.value),
                    )
                    .returningResult(CHAT_MEMBERS.CHAT_ID),
            )
        val removedChatId = removed.field(CHAT_MEMBERS.CHAT_ID)!!
        val updated = db.with(removed)
            .update(CHATS)
            .set(
                CHATS.MEMBER_COUNT,
                CHATS.MEMBER_COUNT.minus(1),
            )
            .from(removed)
            .where(CHATS.ID.eq(removedChatId))
            .returning(CHATS.ID)
            .fetch()
        check(updated.size <= 1)
        return updated.isNotEmpty()
    }
}
