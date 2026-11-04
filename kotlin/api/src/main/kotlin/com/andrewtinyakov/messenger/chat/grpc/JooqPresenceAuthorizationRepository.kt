package com.andrewtinyakov.messenger.chat.grpc

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.SessionId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqPresenceAuthorizationRepository(
    private val db: DSLContext,
) : PresenceAuthorizationRepository {
    override fun authorizedPeers(sessionId: SessionId, chatId: ChatId, userIds: List<UserId>, now: OffsetDateTime): Set<UserId>? =
        DatabaseObservation.query(DatabaseOperation.PRESENCE_AUTHORIZE) {
            val viewer = CHAT_MEMBERS.`as`("viewer")
            val peer = CHAT_MEMBERS.`as`("peer")
            val rows = db.select(peer.USER_ID)
                .from(SESSIONS)
                .join(viewer).on(viewer.USER_ID.eq(SESSIONS.USER_ID), viewer.CHAT_ID.eq(chatId.value))
                .join(CHATS).on(CHATS.ID.eq(viewer.CHAT_ID), CHATS.DELETED_AT.isNull)
                .leftJoin(peer).on(peer.CHAT_ID.eq(CHATS.ID), peer.USER_ID.`in`(userIds.map(UserId::value)))
                .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.EXPIRES_AT.gt(now))
                .fetch()
            if (rows.isEmpty()) null else rows.mapNotNull { it.get(peer.USER_ID)?.let(::UserId) }.toSet()
        }
}
