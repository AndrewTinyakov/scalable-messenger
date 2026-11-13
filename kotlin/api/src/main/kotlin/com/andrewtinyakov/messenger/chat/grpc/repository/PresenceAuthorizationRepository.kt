package com.andrewtinyakov.messenger.chat.grpc.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import java.time.OffsetDateTime

interface PresenceAuthorizationRepository {
    fun authorizedPeers(sessionId: SessionId, chatId: ChatId, userIds: List<UserId>, now: OffsetDateTime): Set<UserId>?
}
