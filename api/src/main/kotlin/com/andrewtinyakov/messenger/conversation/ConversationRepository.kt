package com.andrewtinyakov.messenger.conversation

import com.andrewtinyakov.messenger.auth.UserView
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CONVERSATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CONVERSATION_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import org.jooq.DSLContext
import org.springframework.stereotype.Repository

data class ConversationRecordView(
    val kind: String,
    val name: String?,
    val nextSequence: Long,
)

interface ConversationRepository {
    fun listIds(userId: String): List<String>

    fun findByDirectKey(key: String): String?

    fun userExists(userId: String): Boolean

    fun insertDirect(id: String, key: String)

    fun insertGroup(id: String, name: String, ownerId: String)

    fun insertMembers(conversationId: String, userIds: List<String>)

    fun find(conversationId: String): ConversationRecordView?

    fun members(conversationId: String): List<UserView>

    fun isMember(conversationId: String, userId: String): Boolean

    fun lockGroupOwner(conversationId: String): String?

    fun deleteMember(conversationId: String, userId: String): Boolean
}

@Repository
class JooqConversationRepository(
    private val db: DSLContext,
) : ConversationRepository {
    override fun listIds(userId: String): List<String> =
        db.select(CONVERSATION_MEMBERS.CONVERSATION_ID)
            .from(CONVERSATION_MEMBERS)
            .where(CONVERSATION_MEMBERS.USER_ID.eq(userId))
            .orderBy(CONVERSATION_MEMBERS.JOINED_AT.desc())
            .limit(100)
            .fetch(CONVERSATION_MEMBERS.CONVERSATION_ID)

    override fun findByDirectKey(key: String): String? =
        db.select(CONVERSATIONS.ID)
            .from(CONVERSATIONS)
            .where(CONVERSATIONS.DIRECT_PAIR_KEY.eq(key))
            .fetchOne(CONVERSATIONS.ID)

    override fun userExists(userId: String): Boolean =
        db.fetchExists(db.selectOne().from(USERS).where(USERS.ID.eq(userId)))

    override fun insertDirect(id: String, key: String) {
        check(
            db.insertInto(CONVERSATIONS)
                .set(CONVERSATIONS.ID, id)
                .set(CONVERSATIONS.KIND, "direct")
                .set(CONVERSATIONS.DIRECT_PAIR_KEY, key)
                .execute() == 1,
        )
    }

    override fun insertGroup(id: String, name: String, ownerId: String) {
        check(
            db.insertInto(CONVERSATIONS)
                .set(CONVERSATIONS.ID, id)
                .set(CONVERSATIONS.KIND, "group")
                .set(CONVERSATIONS.NAME, name)
                .set(CONVERSATIONS.OWNER_ID, ownerId)
                .execute() == 1,
        )
    }

    override fun insertMembers(conversationId: String, userIds: List<String>) {
        if (userIds.isEmpty()) return
        val query = db.insertInto(CONVERSATION_MEMBERS, CONVERSATION_MEMBERS.CONVERSATION_ID, CONVERSATION_MEMBERS.USER_ID)
        userIds.forEach { query.values(conversationId, it) }
        check(query.execute() == userIds.size)
    }

    override fun find(conversationId: String): ConversationRecordView? =
        db.selectFrom(CONVERSATIONS)
            .where(CONVERSATIONS.ID.eq(conversationId))
            .fetchOne()?.let { ConversationRecordView(it.kind!!, it.name, it.nextSequence!!) }

    override fun members(conversationId: String): List<UserView> =
        db.select(USERS.ID, USERS.USERNAME)
            .from(CONVERSATION_MEMBERS)
            .join(USERS).on(CONVERSATION_MEMBERS.USER_ID.eq(USERS.ID))
            .where(CONVERSATION_MEMBERS.CONVERSATION_ID.eq(conversationId))
            .orderBy(USERS.USERNAME)
            .fetch { UserView(it.value1()!!, it.value2()!!) }

    override fun isMember(conversationId: String, userId: String): Boolean =
        db.fetchExists(
            db.selectOne().from(CONVERSATION_MEMBERS).where(
                CONVERSATION_MEMBERS.CONVERSATION_ID.eq(conversationId),
                CONVERSATION_MEMBERS.USER_ID.eq(userId),
            ),
        )

    override fun lockGroupOwner(conversationId: String): String? =
        db.selectFrom(CONVERSATIONS)
            .where(CONVERSATIONS.ID.eq(conversationId), CONVERSATIONS.KIND.eq("group"))
            .forUpdate()
            .fetchOne()?.ownerId

    override fun deleteMember(conversationId: String, userId: String): Boolean =
        db.deleteFrom(CONVERSATION_MEMBERS)
            .where(
                CONVERSATION_MEMBERS.CONVERSATION_ID.eq(conversationId),
                CONVERSATION_MEMBERS.USER_ID.eq(userId),
            ).execute() == 1
}
