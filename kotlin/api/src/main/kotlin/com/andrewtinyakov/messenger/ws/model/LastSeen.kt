package com.andrewtinyakov.messenger.ws.model

import com.andrewtinyakov.messenger.auth.model.UserId
import java.time.OffsetDateTime

data class LastSeen(
    val userId: UserId,
    val seenAt: OffsetDateTime,
) {
    companion object {
        const val MAX_ENTRIES = 1000
    }
}
