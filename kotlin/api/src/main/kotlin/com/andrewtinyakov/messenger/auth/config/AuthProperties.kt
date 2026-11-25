package com.andrewtinyakov.messenger.auth.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties("messenger.auth")
data class AuthProperties(
    val cookieSecure: Boolean = true,
    val sessionCleanupBatchSize: Int = 500,
    val sessionLifetime: Duration = Duration.ofDays(30),
    val sessionRenewalInterval: Duration = Duration.ofHours(24),
    val retiredSessionGrace: Duration = Duration.ofSeconds(60),
    val loginThrottle: LoginThrottleProperties = LoginThrottleProperties(),
) {
    init {
        require(sessionCleanupBatchSize > 0) { "Session cleanup batch size must be positive" }
        require(!sessionRenewalInterval.isNegative && sessionRenewalInterval < sessionLifetime) {
            "Session renewal interval must be shorter than the session lifetime"
        }
        require(!retiredSessionGrace.isNegative && retiredSessionGrace < sessionRenewalInterval) {
            "Retired session grace must be shorter than the session renewal interval"
        }
    }
}
