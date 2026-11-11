package com.andrewtinyakov.messenger.infrastructure.messaging.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.messaging")
data class MessagingProperties(
    val deliveryLimit: Int = 20,
    val maxQueueLength: Int = 10000,
    val sendBatchSize: Int = 16,
) {
    init {
        require(deliveryLimit > 0)
        require(maxQueueLength > 0)
        require(sendBatchSize in 1..16)
    }
}
