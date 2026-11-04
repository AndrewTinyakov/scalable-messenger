package com.andrewtinyakov.messenger.infrastructure.outbox

import org.springframework.boot.context.properties.ConfigurationProperties
import java.util.concurrent.TimeUnit

internal const val MAX_EVENT_BYTES = 65536

@ConfigurationProperties("messenger.publisher")
data class PublisherProperties(
    val pollMs: Int = 1000,
    val batchSize: Int = 100,
    val leaseSeconds: Long = 30,
    val concurrency: Int = 16,
    val batchBytes: Int = 4194304,
    val publishTimeoutMs: Long = 1000,
    val roomBatchSize: Int = 16,
) {
    init {
        require(pollMs in 100..60000) { "Publisher poll interval must be between 100 and 60000 milliseconds" }
        require(batchSize in 1..500) { "Publisher batch size must be between 1 and 500 events" }
        require(leaseSeconds in 5..300) { "Publisher lease must be between 5 and 300 seconds" }
        require(concurrency in 1..64) { "Publisher concurrency must be between 1 and 64" }
        require(roomBatchSize in 1..100) { "Room batch size must be between 1 and 100 events" }
        require(batchBytes in MAX_EVENT_BYTES..33554432) { "Publisher batch byte limit must be between 65536 and 33554432" }
        require(publishTimeoutMs in 1..TimeUnit.SECONDS.toMillis(leaseSeconds) / 4) {
            "Publisher timeout must be positive and no more than one quarter of its lease"
        }
    }
}
