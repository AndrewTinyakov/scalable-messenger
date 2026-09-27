package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.user.model.User
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqChatRepository(
    private val db: DSLContext,
) : ChatRepository {
    override fun findByMember(
        userId: String,
        beforeJoinedAt: OffsetDateTime?,
        beforeChatId: String?,
        limit: Int,
    ): List<MemberChat> =
        db.select(CHATS.ID, CHATS.KIND, CHATS.NAME, CHATS.NEXT_SEQUENCE, CHAT_MEMBERS.JOINED_AT, CHATS.MEMBER_COUNT)
            .from(CHAT_MEMBERS)
            .join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.USER_ID.eq(userId))
            .and(
                if (beforeJoinedAt != null && beforeChatId != null) {
                    CHAT_MEMBERS.JOINED_AT.lt(beforeJoinedAt).or(
                        CHAT_MEMBERS.JOINED_AT.eq(beforeJoinedAt).and(CHAT_MEMBERS.CHAT_ID.lt(beforeChatId)),
                    )
                } else {
                    org.jooq.impl.DSL.trueCondition()
                },
            )
            .orderBy(CHAT_MEMBERS.JOINED_AT.desc(), CHAT_MEMBERS.CHAT_ID.desc())
            .limit(limit)
            .fetch { row ->
                MemberChat(
                    Chat(
                        id = row.value1()!!,
                        kind = ChatKind.valueOf(row.value2()!!.uppercase()),
                        name = row.value3(),
                        lastSequence = row.value4()!! - 1,
                    ),
                    row.value5()!!,
                    row.value6()!!,
                )
            }

    override fun findMembersByChatIds(chatIds: List<String>): Map<String, List<User>> {
        if (chatIds.isEmpty()) return emptyMap()
        val placeholders = chatIds.joinToString(",") { "?" }
        return db.fetch(
            """select chat_id, id, username from (
                select cm.chat_id, u.id, u.username,
                       row_number() over (partition by cm.chat_id order by u.username) as rank
                from chat_members cm join users u on u.id = cm.user_id
                where cm.chat_id in ($placeholders)
            ) ranked where rank <= 50 order by chat_id, username""",
            *chatIds.toTypedArray(),
        ).groupBy(
            { it.get("chat_id", String::class.java)!! },
            { User(it.get("id", String::class.java)!!, it.get("username", String::class.java)!!) },
        )
    }

    override fun countMembers(chatId: String): Int =
        db.select(CHATS.MEMBER_COUNT).from(CHATS).where(CHATS.ID.eq(chatId)).fetchOne(CHATS.MEMBER_COUNT)!!

    override fun existingMemberIds(chatId: String, userIds: List<String>): Set<String> =
        db.select(CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId), CHAT_MEMBERS.USER_ID.`in`(userIds))
            .fetch(CHAT_MEMBERS.USER_ID).filterNotNull().toSet()

    override fun lockUsers(userIds: List<String>) {
        db.select(USERS.ID).from(USERS).where(USERS.ID.`in`(userIds)).orderBy(USERS.ID).forUpdate().fetch()
    }

    override fun groupCountsByUser(userIds: List<String>): Map<String, Int> =
        db.select(CHAT_MEMBERS.USER_ID, org.jooq.impl.DSL.count())
            .from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.USER_ID.`in`(userIds), CHATS.KIND.eq("group"))
            .groupBy(CHAT_MEMBERS.USER_ID)
            .fetchMap(CHAT_MEMBERS.USER_ID, org.jooq.impl.DSL.count())

    override fun findByDirectKey(key: String): String? =
        db.select(CHATS.ID)
            .from(CHATS)
            .where(CHATS.DIRECT_PAIR_KEY.eq(key))
            .fetchOne(CHATS.ID)

    override fun lockDirectPair(key: String) {
        db.fetch("select pg_advisory_xact_lock(hashtextextended(?, 0))", "direct:$key")
    }

    override fun findKindForUpdate(chatId: String): ChatKind? =
        db.selectFrom(CHATS)
            .where(CHATS.ID.eq(chatId))
            .forUpdate()
            .fetchOne()?.kind?.let { ChatKind.valueOf(it.uppercase()) }

    override fun insertDirect(id: String, key: String) {
        check(
            db.insertInto(CHATS)
                .set(CHATS.ID, id)
                .set(CHATS.KIND, "direct")
                .set(CHATS.DIRECT_PAIR_KEY, key)
                .execute() == 1,
        )
    }

    override fun insertGroup(id: String, name: String, ownerId: String) {
        check(
            db.insertInto(CHATS)
                .set(CHATS.ID, id)
                .set(CHATS.KIND, "group")
                .set(CHATS.NAME, name)
                .set(CHATS.OWNER_ID, ownerId)
                .execute() == 1,
        )
    }

    override fun insertMembers(chatId: String, userIds: List<String>) {
        if (userIds.isEmpty()) return
        userIds.chunked(500).forEach { chunk ->
            val query = db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID)
            chunk.forEach { query.values(chatId, it) }
            check(query.execute() == chunk.size)
            check(
                db.update(CHATS).set(CHATS.MEMBER_COUNT, CHATS.MEMBER_COUNT.plus(chunk.size))
                    .where(CHATS.ID.eq(chatId)).execute() == 1,
            )
        }
    }

    override fun findById(chatId: String): Chat? =
        db.selectFrom(CHATS)
            .where(CHATS.ID.eq(chatId))
            .fetchOne()?.let { Chat(it.id!!, ChatKind.valueOf(it.kind!!.uppercase()), it.name, it.nextSequence!! - 1) }

    override fun findMembers(chatId: String): List<User> =
        db.fetch(
            """select u.id, u.username from (
                select user_id from chat_members where chat_id = ? order by user_id limit 50
            ) preview join users u on u.id = preview.user_id order by preview.user_id""",
            chatId,
        ).map { User(it.get("id", String::class.java)!!, it.get("username", String::class.java)!!) }

    override fun isMember(chatId: String, userId: String): Boolean =
        db.fetchExists(
            db.selectOne().from(CHAT_MEMBERS).where(
                CHAT_MEMBERS.CHAT_ID.eq(chatId),
                CHAT_MEMBERS.USER_ID.eq(userId),
            ),
        )

    override fun isGroupMember(chatId: String, userId: String): Boolean =
        db.fetchExists(
            db.selectOne().from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
                .where(CHAT_MEMBERS.CHAT_ID.eq(chatId), CHAT_MEMBERS.USER_ID.eq(userId), CHATS.KIND.eq("group")),
        )

    override fun groupMemberships(chatIds: List<String>, userId: String): Set<String> {
        if (chatIds.isEmpty()) return emptySet()
        return db.select(CHAT_MEMBERS.CHAT_ID).from(CHAT_MEMBERS)
            .join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.USER_ID.eq(userId), CHAT_MEMBERS.CHAT_ID.`in`(chatIds), CHATS.KIND.eq("group"))
            .fetch(CHAT_MEMBERS.CHAT_ID).filterNotNull().toSet()
    }

    override fun allocateSequence(chatId: String): Long =
        db.update(CHATS)
            .set(CHATS.NEXT_SEQUENCE, CHATS.NEXT_SEQUENCE.plus(1L))
            .where(CHATS.ID.eq(chatId))
            .returning(CHATS.NEXT_SEQUENCE)
            .fetchOne()?.nextSequence?.minus(1L)
            ?: error("Chat disappeared while allocating sequence")

    override fun findMemberIds(chatId: String): List<String> =
        db.select(CHAT_MEMBERS.USER_ID)
            .from(CHAT_MEMBERS)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId))
            .fetch(CHAT_MEMBERS.USER_ID)

    override fun findGroupOwnerForUpdate(chatId: String): String? =
        db.selectFrom(CHATS)
            .where(CHATS.ID.eq(chatId), CHATS.KIND.eq("group"))
            .forUpdate()
            .fetchOne()?.ownerId

    override fun deleteMember(chatId: String, userId: String): Boolean =
        (
            db.deleteFrom(CHAT_MEMBERS)
                .where(
                    CHAT_MEMBERS.CHAT_ID.eq(chatId),
                    CHAT_MEMBERS.USER_ID.eq(userId),
                ).execute() == 1
        ).also { deleted ->
            if (deleted) {
                check(
                    db.update(CHATS).set(CHATS.MEMBER_COUNT, CHATS.MEMBER_COUNT.minus(1))
                        .where(CHATS.ID.eq(chatId)).execute() == 1,
                )
            }
        }
}
