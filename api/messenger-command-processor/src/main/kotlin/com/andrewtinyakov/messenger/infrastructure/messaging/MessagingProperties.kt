package com.andrewtinyakov.messenger.infrastructure.messaging

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.messaging")
data class MessagingProperties(
    val deliveryLimit: Int = 20,
    val maxQueueLength: Int = 10000,
) {
    init {
        require(deliveryLimit > 0)
        require(maxQueueLength > 0)
    }
}
