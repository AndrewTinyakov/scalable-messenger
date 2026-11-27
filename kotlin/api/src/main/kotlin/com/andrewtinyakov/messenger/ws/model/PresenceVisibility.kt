package com.andrewtinyakov.messenger.ws.model

import com.andrewtinyakov.messenger.auth.model.UserId
import java.time.OffsetDateTime

data class PresenceVisibility(
    val userId: UserId,
    val level: PresenceLevel,
    val lastSeenAt: OffsetDateTime?,
) {
    companion object {
        const val MAX_SUBJECTS = 500
    }
}
