package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.GroupAuthorization
import java.time.OffsetDateTime

interface GroupAuthorizationRepository {
    fun findAuthorization(sessionId: SessionId, now: OffsetDateTime, chatIds: List<ChatId>): GroupAuthorization?
}
