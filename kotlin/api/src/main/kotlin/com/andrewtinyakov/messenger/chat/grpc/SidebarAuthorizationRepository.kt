package com.andrewtinyakov.messenger.chat.grpc

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.SessionId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

data class SidebarChatAuthorization(
    val chatId: ChatId,
    val peerId: UserId?,
    val group: Boolean,
)

interface SidebarAuthorizationRepository {
    fun authorize(sessionId: SessionId, chatIds: List<ChatId>, now: OffsetDateTime): List<SidebarChatAuthorization>?
}
