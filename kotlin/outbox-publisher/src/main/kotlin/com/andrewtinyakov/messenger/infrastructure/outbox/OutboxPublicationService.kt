package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.redis.RoomEventPublisher
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime
import java.util.UUID

@Service
class OutboxPublicationService(
    private val repository: OutboxRepository,
    private val tx: TransactionTemplate,
    private val publisher: RoomEventPublisher,
    private val metrics: MeterRegistry,
    private val clock: Clock,
    @Value("\${messenger.publisher.batch-size:100}") private val batchSize: Int,
    @Value("\${messenger.publisher.lease-seconds:30}") private val leaseSeconds: Long,
) {
    private val owner = UUID.randomUUID().toString()
    private val log = org.slf4j.LoggerFactory.getLogger(javaClass)

    fun publishBatch(): Int {
        require(batchSize in 1..500)
        require(leaseSeconds in 5..300)
        val sample = Timer.start(metrics)
        try {
            return publishClaimedBatch()
        } finally {
            sample.stop(metrics.timer("messenger.outbox.batch"))
        }
    }

    private fun publishClaimedBatch(): Int {
        val rows = claim()
        if (rows.isNotEmpty()) metrics.counter("messenger.outbox.claimed").increment(rows.size.toDouble())
        val published = ArrayList<String>(rows.size)
        for (row in rows) {
            try {
                publisher.publish(row)
                published.add(row.id)
                metrics.counter("messenger.outbox.publish", "result", "success").increment()
            } catch (error: Exception) {
                metrics.counter("messenger.outbox.publish", "result", "failure").increment()
                log.error("Outbox publication failed for event {}", row.id, error)
            }
        }
        if (published.isNotEmpty()) {
            tx.executeWithoutResult { repository.complete(published, owner) }
        }
        return published.size
    }

    private fun claim(): List<OutboxMessage> = tx.execute {
        val now = OffsetDateTime.now(clock)
        repository.claim(now, batchSize, owner, now.plusSeconds(leaseSeconds))
    }
}
