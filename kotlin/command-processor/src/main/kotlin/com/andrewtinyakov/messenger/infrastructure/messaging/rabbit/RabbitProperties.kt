package com.andrewtinyakov.messenger.infrastructure.messaging.rabbit

import com.andrewtinyakov.messenger.message.model.SendBatch
import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties("messenger.messaging")
data class RabbitProperties(
    val deliveryLimit: Int = 20,
    val maxQueueLength: Int = 10000,
    val sendBatchSize: Int = SendBatch.MAX_SIZE,
    val receiveTimeout: Duration = Duration.ofMillis(1),
    val batchReceiveTimeout: Duration = Duration.ofMillis(5),
    val quorumInitialGroupSize: Int = 3,
    val failedDeliveryRetryMinDelay: Duration = Duration.ofSeconds(1),
    val failedDeliveryRetryMaxDelay: Duration = Duration.ofSeconds(30),
) {
    init {
        require(deliveryLimit > 0) { "Delivery limit must be positive" }
        require(maxQueueLength > 0) { "Maximum queue length must be positive" }
        require(sendBatchSize in 1..SendBatch.MAX_SIZE) { "Send batch size must be between 1 and ${SendBatch.MAX_SIZE}" }
        require(receiveTimeout.isPositive) { "Receive timeout must be positive" }
        require(batchReceiveTimeout.isPositive) { "Batch receive timeout must be positive" }
        require(quorumInitialGroupSize > 0) { "Quorum initial group size must be positive" }
        require(failedDeliveryRetryMinDelay.isPositive) { "Failed delivery retry minimum delay must be positive" }
        require(failedDeliveryRetryMaxDelay >= failedDeliveryRetryMinDelay) {
            "Failed delivery retry maximum delay must be at least its minimum delay"
        }
        require(failedDeliveryRetryMaxDelay.toMillis() <= Int.MAX_VALUE) { "Failed delivery retry maximum delay is too large" }
    }
}
