package com.andrewtinyakov.messenger.ws.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import com.andrewtinyakov.messenger.ws.model.LastSeen
import com.andrewtinyakov.messenger.ws.model.OnlineCountMembers
import com.andrewtinyakov.messenger.ws.model.PresenceLevel
import com.andrewtinyakov.messenger.ws.model.PresenceVisibility
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqPresenceRepository(
    private val db: DSLContext,
) : PresenceRepository {
    override fun presenceVisibility(sessionId: SessionId, userIds: List<UserId>, now: OffsetDateTime): List<PresenceVisibility>? {
        val viewerId = viewer(sessionId, now) ?: return null
        val viewer = CHAT_MEMBERS.`as`("viewer")
        val subject = CHAT_MEMBERS.`as`("subject")
        val sharesChat = DSL.exists(
            DSL.selectOne().from(viewer)
                .join(subject).on(subject.CHAT_ID.eq(viewer.CHAT_ID), subject.USER_ID.eq(USERS.ID))
                .join(CHATS).on(CHATS.ID.eq(viewer.CHAT_ID), CHATS.DELETED_AT.isNull)
                .where(viewer.USER_ID.eq(viewerId)),
        )
        val visible = DSL.field(USERS.ID.eq(viewerId).or(sharesChat))
        val rows = db.select(USERS.ID, USERS.LAST_SEEN_AT, visible).from(USERS)
            .where(USERS.ID.`in`(userIds.map(UserId::value)))
            .fetch()
            .associateBy { it.get(USERS.ID) }
        return userIds.map { userId ->
            val row = rows[userId.value]
            if (row == null || row.get(visible) != true) {
                PresenceVisibility(userId, PresenceLevel.NONE, null)
            } else {
                PresenceVisibility(userId, PresenceLevel.FULL, row.get(USERS.LAST_SEEN_AT))
            }
        }
    }

    override fun onlineCountMembers(sessionId: SessionId, chatId: ChatId, limit: Int, now: OffsetDateTime): OnlineCountMembers? {
        val viewerId = viewer(sessionId, now) ?: return null
        val member = CHAT_MEMBERS.`as`("member")
        val chat = db.select(CHATS.ID).from(CHATS)
            .join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID), CHAT_MEMBERS.USER_ID.eq(viewerId))
            .where(CHATS.ID.eq(chatId.value), CHATS.KIND.eq(ChatKind.GROUP), CHATS.DELETED_AT.isNull)
            .fetchOne() ?: return null
        val members = db.select(member.USER_ID).from(member)
            .where(member.CHAT_ID.eq(chat.value1()))
            .orderBy(member.USER_ID)
            .limit(limit + 1)
            .fetch(member.USER_ID)
        if (members.size <= limit) return OnlineCountMembers(members.size, members.map(::UserId))
        val count = db.fetchCount(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID.eq(chatId.value))
        return OnlineCountMembers(count, emptyList())
    }

    override fun recordLastSeen(entries: List<LastSeen>) {
        if (entries.isEmpty()) return
        val latest = entries.groupBy { it.userId }.map { (userId, seen) -> userId to seen.maxOf { it.seenAt } }
        val values = DSL.values(*latest.map { (userId, seenAt) -> DSL.row(userId.value, seenAt) }.toTypedArray())
            .`as`("seen", "user_id", "seen_at")
        val seenUser = values.field(0, USERS.ID.dataType)!!
        val seenAt = values.field(1, USERS.LAST_SEEN_AT.dataType)!!
        val locked = DSL.name("locked").fields("id").asMaterialized(
            DSL.select(USERS.ID).from(USERS)
                .where(USERS.ID.`in`(latest.map { (userId) -> userId.value }))
                .orderBy(USERS.ID)
                .forNoKeyUpdate(),
        )
        db.with(locked)
            .update(USERS)
            .set(USERS.LAST_SEEN_AT, DSL.greatest(USERS.LAST_SEEN_AT, seenAt))
            .from(values)
            .where(USERS.ID.eq(seenUser), USERS.ID.`in`(DSL.select(locked.field(0, USERS.ID.dataType)).from(locked)))
            .execute()
    }

    private fun viewer(sessionId: SessionId, now: OffsetDateTime): String? =
        db.select(SESSIONS.USER_ID).from(SESSIONS)
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.EXPIRES_AT.gt(now))
            .fetchOne(SESSIONS.USER_ID)
}
