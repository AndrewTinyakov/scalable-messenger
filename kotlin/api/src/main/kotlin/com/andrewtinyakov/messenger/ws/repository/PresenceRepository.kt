package com.andrewtinyakov.messenger.ws.repository

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.ws.model.LastSeen
import com.andrewtinyakov.messenger.ws.model.OnlineCountMembers
import com.andrewtinyakov.messenger.ws.model.PresenceVisibility
import java.time.OffsetDateTime

interface PresenceRepository {
    fun presenceVisibility(sessionId: SessionId, userIds: List<UserId>, now: OffsetDateTime): List<PresenceVisibility>?

    fun onlineCountMembers(sessionId: SessionId, chatId: ChatId, limit: Int, now: OffsetDateTime): OnlineCountMembers?

    fun recordLastSeen(entries: List<LastSeen>)
}
