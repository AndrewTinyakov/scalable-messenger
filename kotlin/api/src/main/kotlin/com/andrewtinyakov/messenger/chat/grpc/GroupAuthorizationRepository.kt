package com.andrewtinyakov.messenger.chat.grpc

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.SessionId
import java.time.OffsetDateTime

data class GroupAuthorization(
    val authorizedChatIds: Set<ChatId>,
)

interface GroupAuthorizationRepository {
    fun findAuthorization(sessionId: SessionId, now: OffsetDateTime, chatIds: List<ChatId>): GroupAuthorization?
}
