package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.GroupAuthorization
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
class JooqGroupAuthorizationRepository(
    private val db: DSLContext,
) : GroupAuthorizationRepository {
    override fun findAuthorization(
        sessionId: SessionId,
        now: OffsetDateTime,
        chatIds: List<ChatId>,
    ): GroupAuthorization? = DatabaseObservation.query(DatabaseOperation.GROUP_AUTHORIZATION_FIND_AUTHORIZATION) {
        val rows = db.select(SESSIONS.TOKEN_HASH, CHATS.ID)
            .from(SESSIONS)
            .leftJoin(CHAT_MEMBERS).on(
                CHAT_MEMBERS.USER_ID.eq(SESSIONS.USER_ID),
                CHAT_MEMBERS.CHAT_ID.`in`(chatIds.map(ChatId::value)),
            )
            .leftJoin(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID), CHATS.KIND.eq(ChatKind.GROUP), CHATS.DELETED_AT.isNull)
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.EXPIRES_AT.gt(now))
            .fetch()
        if (rows.isEmpty()) return null
        return GroupAuthorization(
            authorizedChatIds = rows.mapNotNull { it.get(CHATS.ID)?.let(::ChatId) }.toSet(),
        )
    }
}
