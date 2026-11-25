package com.andrewtinyakov.messenger.auth.model

import java.time.Duration

sealed interface LoginAttempt {
    data object Allowed : LoginAttempt

    data class Blocked(
        val retryAfter: Duration,
    ) : LoginAttempt
}
