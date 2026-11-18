package com.andrewtinyakov.messenger.auth.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.auth")
data class AuthProperties(
    val cookieSecure: Boolean = true,
    val sessionCleanupBatchSize: Int = 500,
) {
    init {
        require(sessionCleanupBatchSize > 0) { "Session cleanup batch size must be positive" }
    }
}
