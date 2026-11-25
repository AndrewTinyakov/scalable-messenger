package com.andrewtinyakov.messenger.auth.model

import java.time.OffsetDateTime

data class LoginThrottle(
    val attemptCount: Int,
    val lastAttemptAt: OffsetDateTime,
    val blockedUntil: OffsetDateTime,
)
