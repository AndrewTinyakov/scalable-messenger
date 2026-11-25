package com.andrewtinyakov.messenger.ws.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.ws.model.SidebarChatAuthorization
import java.time.OffsetDateTime

interface SidebarAuthorizationRepository {
    fun authorize(sessionId: SessionId, chatIds: List<ChatId>, now: OffsetDateTime): List<SidebarChatAuthorization>?
}
