package com.andrewtinyakov.messenger.chat.grpc.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.grpc.model.SidebarChatAuthorization
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqSidebarAuthorizationRepository(
    private val db: DSLContext,
) : SidebarAuthorizationRepository {
    override fun authorize(sessionId: SessionId, chatIds: List<ChatId>, now: OffsetDateTime): List<SidebarChatAuthorization>? {
        val viewer = CHAT_MEMBERS.`as`("viewer")
        val peer = CHAT_MEMBERS.`as`("peer")
        val rows = db.select(CHATS.ID, CHATS.KIND, peer.USER_ID).from(SESSIONS)
            .leftJoin(viewer).on(viewer.USER_ID.eq(SESSIONS.USER_ID), viewer.CHAT_ID.`in`(chatIds.map(ChatId::value)))
            .leftJoin(CHATS).on(
                CHATS.ID.eq(viewer.CHAT_ID),
                CHATS.DELETED_AT.isNull,
                viewer.HIDDEN_THROUGH_SEQUENCE.isNull.or(CHATS.NEXT_SEQUENCE.minus(1L).gt(viewer.HIDDEN_THROUGH_SEQUENCE)),
            )
            .leftJoin(peer).on(peer.CHAT_ID.eq(CHATS.ID), CHATS.KIND.eq(ChatKind.DIRECT), peer.USER_ID.ne(SESSIONS.USER_ID))
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.EXPIRES_AT.gt(now)).fetch()
        if (rows.isEmpty()) return null
        return rows.mapNotNull { row ->
            row.get(CHATS.ID)?.let {
                SidebarChatAuthorization(
                    ChatId(it),
                    row.get(peer.USER_ID)?.let(::UserId),
                    row.get(CHATS.KIND) == ChatKind.GROUP,
                )
            }
        }
    }
}
