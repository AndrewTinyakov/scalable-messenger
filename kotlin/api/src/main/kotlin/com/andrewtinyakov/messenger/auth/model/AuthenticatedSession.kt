package com.andrewtinyakov.messenger.auth.model

import com.andrewtinyakov.messenger.shared.id.DeviceId
import com.andrewtinyakov.messenger.shared.id.SessionId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.Instant

data class AuthenticatedSession(
    val userId: UserId,
    val deviceId: DeviceId,
    val sessionId: SessionId,
    val expiresAt: Instant,
)
