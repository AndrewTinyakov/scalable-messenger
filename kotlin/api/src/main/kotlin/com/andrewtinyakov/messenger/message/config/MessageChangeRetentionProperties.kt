package com.andrewtinyakov.messenger.message.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties("messenger.message-changes")
data class MessageChangeRetentionProperties(
    val retention: Duration = Duration.ofDays(7),
    val pruneBatchSize: Int = 1000,
) {
    init {
        require(retention.isPositive) { "Message change retention must be positive" }
        require(pruneBatchSize in 1..1000) { "Message change prune batch size must be between 1 and 1000" }
    }
}
