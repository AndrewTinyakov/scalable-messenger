package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.shared.id.EventId
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@Service
class OutboxPublicationService(
    private val repository: OutboxRepository,
    private val tx: TransactionTemplate,
    private val publisher: OutboxEventPublisher,
    private val metrics: MeterRegistry,
    private val clock: Clock,
    private val properties: PublisherProperties,
) {
    private val owner = UUID.randomUUID().toString()
    private val log = org.slf4j.LoggerFactory.getLogger(javaClass)
    private val publicationAgeTimers = ConcurrentHashMap<String, Timer>()

    @Synchronized
    fun publishBatch(): Int {
        val sample = Timer.start(metrics)
        var outcome = "failed"
        try {
            val result = publishClaimedBatch()
            outcome = result.outcome
            return result.completed
        } finally {
            sample.stop(metrics.timer("messenger.outbox.batch", "outcome", outcome))
        }
    }

    private data class BatchPublication(
        val completed: Int,
        val outcome: String,
    )

    private data class RoomPublication(
        val published: List<EventId>,
        val outcome: String,
    )

    private fun publishClaimedBatch(): BatchPublication {
        val completionBudgetMs = maxOf(1000, properties.publishTimeoutMs * 2)
        val workBudgetMs = TimeUnit.SECONDS.toMillis(properties.leaseSeconds) - completionBudgetMs
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(workBudgetMs)
        val now = OffsetDateTime.now(clock)
        val leaseUntil = now.plusSeconds(properties.leaseSeconds)
        val limit = minOf(properties.batchSize, properties.batchBytes / MAX_EVENT_BYTES)
        val rooms = observePhase("claim") {
            tx.observedExecute(DatabaseTransaction.OUTBOX_CLAIM) {
                val anchors = repository.claim(now, minOf(limit, properties.concurrency), owner, leaseUntil)
                var remaining = limit - anchors.size
                anchors.groupBy { it.room }.values.map { rows ->
                    val anchor = rows.first()
                    val wanted = if (anchor.groupPublicationOrder != null) properties.roomBatchSize - rows.size else 0
                    val tail = if (wanted > 0 && remaining > 0) {
                        repository.claimGroupTail(anchor, OffsetDateTime.now(clock), minOf(wanted, remaining), owner, leaseUntil)
                    } else {
                        emptyList()
                    }
                    remaining -= tail.size
                    rows + tail
                }
            }
        }
        if (rooms.isEmpty()) return BatchPublication(0, "empty")
        if (SendStageRecorder.isEnabled) {
            rooms.forEach { rows ->
                rows.forEach { row -> SendStageRecorder.record(SendStage.OUTBOX_CLAIM_COMMITTED, eventId = row.id.value) }
            }
        }
        metrics.counter("messenger.outbox.claimed").increment(rooms.sumOf { it.size }.toDouble())
        val prepared = observePhase("hydrate") {
            publisher.prepare(rooms.flatten()).associateBy { it.id }
        }
        val published = Executors.newVirtualThreadPerTaskExecutor().use { executor ->
            val tasks = rooms.map { roomRows ->
                executor.submit(
                    Callable { publishClaimedRoom(roomRows.map { checkNotNull(prepared[it.id]) }, deadline) },
                )
            }
            tasks.map { it.get() }
        }
        return BatchPublication(published.sumOf { it.completed }, if (published.any { it.outcome == "failed" }) "failed" else "work")
    }

    private fun publishClaimedRoom(
        rows: List<OutboxMessage>,
        deadline: Long,
    ): BatchPublication {
        val result = observePhase("publish", { it.outcome }) { publishRoom(rows = rows, deadline = deadline) }
        val completed = result.published
        if (completed.isNotEmpty()) {
            try {
                observePhase("complete") {
                    tx.observedExecuteWithoutResult(DatabaseTransaction.OUTBOX_COMPLETE) { repository.complete(completed, owner) }
                }
            } catch (error: Exception) {
                recordPending("complete_failure", completed.size)
                throw error
            }
        }
        val failed = result.outcome == "failure" || result.outcome == "cancelled"
        return BatchPublication(completed.size, if (failed) "failed" else "work")
    }

    private fun publishRoom(rows: List<OutboxMessage>, deadline: Long): RoomPublication {
        val published = ArrayList<EventId>(rows.size)
        for (row in rows) {
            if (Thread.currentThread().isInterrupted) {
                recordPending("interrupted", rows.size - published.size)
                return RoomPublication(published, "cancelled")
            }
            if (deadline - System.nanoTime() < TimeUnit.MILLISECONDS.toNanos(properties.publishTimeoutMs)) {
                recordPending("deadline", rows.size - published.size)
                return RoomPublication(published, "deadline")
            }
            val publishSample = Timer.start(metrics)
            var outcome = "failure"
            try {
                require(row.payload.toByteArray(StandardCharsets.UTF_8).size <= MAX_EVENT_BYTES) {
                    "Outbox event exceeds publication byte limit"
                }
                recordPublicationAge(row)
                publisher.publish(message = row)
                outcome = "success"
                published.add(row.id)
                metrics.counter("messenger.outbox.publish", "result", "success").increment()
            } catch (error: Exception) {
                metrics.counter("messenger.outbox.publish", "result", "failure").increment()
                log.error("Outbox publication failed for event {}", row.id, error)
                recordPending("publish_failure", rows.size - published.size)
                return RoomPublication(published, "failure")
            } finally {
                publishSample.stop(
                    Timer.builder("messenger.outbox.publication").tag("outcome", outcome)
                        .publishPercentileHistogram().minimumExpectedValue(java.time.Duration.ofMillis(1))
                        .maximumExpectedValue(java.time.Duration.ofMinutes(2)).register(metrics),
                )
            }
        }
        return RoomPublication(published, "success")
    }

    private fun recordPending(reason: String, count: Int) {
        metrics.counter("messenger.outbox.retained", "reason", reason).increment(count.toDouble())
    }

    private fun recordPublicationAge(row: OutboxMessage) {
        try {
            val roomKind = if (row.room.startsWith("group:")) "group" else "user"
            val createdAt = row.createdAt
            val age = createdAt?.let { Duration.between(it, OffsetDateTime.now(clock)) }
            if (age == null || age.isNegative) {
                val reason = if (age == null) "missing" else "future"
                metrics.counter("messenger.outbox.publication.age.invalid", "room_kind", roomKind, "reason", reason).increment()
                return
            }
            publicationAgeTimers.computeIfAbsent(roomKind) {
                Timer.builder("messenger.outbox.publication.age").tag("room_kind", roomKind)
                    .serviceLevelObjectives(*PUBLICATION_AGE_BUCKETS).register(metrics)
            }.record(age)
        } catch (_: RuntimeException) {
        }
    }

    private inline fun <T> observePhase(phase: String, outcome: (T) -> String = { "success" }, action: () -> T): T {
        val sample = Timer.start(metrics)
        var result = "failure"
        try {
            return action().also { result = outcome(it) }
        } finally {
            sample.stop(
                Timer.builder("messenger.outbox.stage").tags("phase", phase, "outcome", result)
                    .publishPercentileHistogram().minimumExpectedValue(java.time.Duration.ofMillis(1))
                    .maximumExpectedValue(java.time.Duration.ofMinutes(2)).register(metrics),
            )
        }
    }

    companion object {
        private val PUBLICATION_AGE_BUCKETS = longArrayOf(1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)
            .map(Duration::ofMillis).toTypedArray()
    }
}
