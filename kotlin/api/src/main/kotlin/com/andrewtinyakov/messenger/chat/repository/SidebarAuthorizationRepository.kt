package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.SidebarChatAuthorization
import java.time.OffsetDateTime

interface SidebarAuthorizationRepository {
    fun authorize(sessionId: SessionId, chatIds: List<ChatId>, now: OffsetDateTime): List<SidebarChatAuthorization>?
}
