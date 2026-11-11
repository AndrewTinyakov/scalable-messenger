package com.andrewtinyakov.messenger.read.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.read")
data class ReadProperties(
    val cleanupBatchSize: Int = 500,
    val notificationBatchSize: Int = 500,
) {
    init {
        require(cleanupBatchSize in 1..1000) { "Read cleanup batch size must be between 1 and 1000" }
        require(notificationBatchSize in 1..1000) { "Read notification batch size must be between 1 and 1000" }
    }
}
