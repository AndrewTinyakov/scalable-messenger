package com.andrewtinyakov.messenger.auth.config

import java.time.Duration

data class LoginThrottleProperties(
    val freeAttempts: Int = 5,
    val baseDelay: Duration = Duration.ofSeconds(1),
    val maxDelay: Duration = Duration.ofMinutes(15),
    val resetAfter: Duration = Duration.ofHours(24),
) {
    init {
        require(freeAttempts > 0)
        require(!baseDelay.isNegative && !baseDelay.isZero)
        require(maxDelay >= baseDelay)
        require(resetAfter > maxDelay)
    }
}
