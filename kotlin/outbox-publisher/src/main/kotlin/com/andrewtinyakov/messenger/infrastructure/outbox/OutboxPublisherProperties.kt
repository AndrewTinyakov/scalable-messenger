package com.andrewtinyakov.messenger.infrastructure.outbox

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.bind.Name
import org.springframework.boot.convert.DurationUnit
import java.time.Duration
import java.time.temporal.ChronoUnit

internal const val MAX_EVENT_BYTES = 65536

@ConfigurationProperties("messenger.publisher")
data class OutboxPublisherProperties(
    @Name("poll-ms")
    val pollInterval: Duration = Duration.ofMillis(1000),
    val batchSize: Int = 100,
    @Name("lease-seconds")
    @DurationUnit(ChronoUnit.SECONDS)
    val lease: Duration = Duration.ofSeconds(30),
    val concurrency: Int = 16,
    val batchBytes: Int = 4194304,
    @Name("publish-timeout-ms")
    val publishTimeout: Duration = Duration.ofMillis(1000),
    val roomBatchSize: Int = 16,
    val workerJoinTimeout: Duration = Duration.ofSeconds(2),
    val roomPublicationQueueCapacity: Int = 500,
) {
    init {
        require(pollInterval in Duration.ofMillis(100)..Duration.ofSeconds(60)) {
            "Publisher poll interval must be between 100 and 60000 milliseconds"
        }
        require(batchSize in 1..500) { "Publisher batch size must be between 1 and 500 events" }
        require(lease in Duration.ofSeconds(5)..Duration.ofSeconds(300)) { "Publisher lease must be between 5 and 300 seconds" }
        require(concurrency in 1..64) { "Publisher concurrency must be between 1 and 64" }
        require(roomBatchSize in 1..100) { "Room batch size must be between 1 and 100 events" }
        require(batchBytes in MAX_EVENT_BYTES..33554432) { "Publisher batch byte limit must be between 65536 and 33554432" }
        require(publishTimeout in Duration.ofMillis(1)..lease.dividedBy(4)) {
            "Publisher timeout must be positive and no more than one quarter of its lease"
        }
        require(workerJoinTimeout.isPositive) { "Publisher worker join timeout must be positive" }
        require(roomPublicationQueueCapacity > 0) { "Room publication queue capacity must be positive" }
    }
}
