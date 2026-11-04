package com.andrewtinyakov.messenger.chat.grpc

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.SessionId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

interface PresenceAuthorizationRepository {
    fun authorizedPeers(sessionId: SessionId, chatId: ChatId, userIds: List<UserId>, now: OffsetDateTime): Set<UserId>?
}
