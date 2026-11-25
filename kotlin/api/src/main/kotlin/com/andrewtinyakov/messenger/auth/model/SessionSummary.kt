package com.andrewtinyakov.messenger.auth.model

import java.time.Instant

data class SessionSummary(
    val sessionId: SessionId,
    val deviceLabel: DeviceLabel,
    val createdAt: Instant,
    val lastUsedAt: Instant,
)
