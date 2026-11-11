package com.andrewtinyakov.messenger.chat.grpc.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.chat.grpc.model.GroupAuthorization
import com.andrewtinyakov.messenger.chat.model.ChatId
import java.time.OffsetDateTime

interface GroupAuthorizationRepository {
    fun findAuthorization(sessionId: SessionId, now: OffsetDateTime, chatIds: List<ChatId>): GroupAuthorization?
}
