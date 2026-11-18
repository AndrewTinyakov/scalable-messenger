package com.andrewtinyakov.messenger.auth.model

import java.time.Instant

data class AuthenticatedSession(
    val userId: UserId,
    val deviceId: DeviceId,
    val sessionId: SessionId,
    val expiresAt: Instant,
    val lastUsedAt: Instant,
)
