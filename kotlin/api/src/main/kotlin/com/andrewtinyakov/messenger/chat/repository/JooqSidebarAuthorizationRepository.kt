package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.SidebarChatAuthorization
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseOperation
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
    override fun authorize(sessionId: SessionId, chatIds: List<ChatId>, now: OffsetDateTime): List<SidebarChatAuthorization>? =
        DatabaseObservation.query(DatabaseOperation.SIDEBAR_AUTHORIZE) {
            val viewer = CHAT_MEMBERS.`as`("viewer")
            val peer = CHAT_MEMBERS.`as`("peer")
            val rows = db.select(CHATS.ID, CHATS.KIND, peer.USER_ID).from(SESSIONS)
                .leftJoin(viewer).on(viewer.USER_ID.eq(SESSIONS.USER_ID), viewer.CHAT_ID.`in`(chatIds.map(ChatId::value)))
                .leftJoin(CHATS).on(
                    CHATS.ID.eq(viewer.CHAT_ID),
                    CHATS.DELETED_AT.isNull,
                    notHidden(viewer),
                )
                .leftJoin(peer).on(peer.CHAT_ID.eq(CHATS.ID), CHATS.KIND.eq(ChatKind.DIRECT), peer.USER_ID.ne(SESSIONS.USER_ID))
                .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.EXPIRES_AT.gt(now)).fetch()
            if (rows.isEmpty()) return@query null
            rows.mapNotNull { row ->
                row.get(CHATS.ID)?.let {
                    SidebarChatAuthorization(
                        chatId = ChatId(it),
                        peerId = row.get(peer.USER_ID)?.let(::UserId),
                        group = row.get(CHATS.KIND) == ChatKind.GROUP,
                    )
                }
            }
        }
}
