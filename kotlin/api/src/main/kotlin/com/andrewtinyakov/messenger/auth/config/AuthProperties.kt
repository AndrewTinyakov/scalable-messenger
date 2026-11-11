package com.andrewtinyakov.messenger.auth.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.nio.charset.StandardCharsets

@ConfigurationProperties("messenger.auth")
data class AuthProperties(
    val wsTicketSecret: String,
    val cookieSecure: Boolean = true,
    val sessionCleanupBatchSize: Int = 500,
) {
    init {
        require(wsTicketSecret.toByteArray(StandardCharsets.UTF_8).size >= 32) { "WS ticket secret must have at least 32 bytes" }
        require(sessionCleanupBatchSize > 0) { "Session cleanup batch size must be positive" }
    }
}
