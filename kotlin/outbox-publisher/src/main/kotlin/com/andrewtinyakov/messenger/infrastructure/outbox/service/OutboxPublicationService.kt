package com.andrewtinyakov.messenger.infrastructure.outbox.service

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.infrastructure.outbox.config.MAX_EVENT_BYTES
import com.andrewtinyakov.messenger.infrastructure.outbox.config.PublisherProperties
import com.andrewtinyakov.messenger.infrastructure.outbox.model.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics.BatchOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics.PublicationOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics.RetentionReason
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics.Stage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxClaimRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@Service
class OutboxPublicationService(
    private val repository: OutboxClaimRepository,
    private val tx: TransactionTemplate,
    private val publisher: OutboxEventPublisher,
    private val metrics: OutboxMetrics,
    private val clock: Clock,
    private val properties: PublisherProperties,
) {
    private val owner = UUID.randomUUID().toString()
    private val log = LoggerFactory.getLogger(javaClass)

    @Synchronized
    fun publishBatch(): Int {
        val sample = metrics.started()
        var outcome = BatchOutcome.FAILED
        try {
            val result = publishClaimedBatch()
            outcome = result.outcome
            return result.completed
        } finally {
            metrics.batchFinished(sample, outcome)
        }
    }

    private data class BatchPublication(
        val completed: Int,
        val outcome: BatchOutcome,
    )

    private data class RoomPublication(
        val published: List<EventId>,
        val outcome: PublicationOutcome,
    )

    private fun publishClaimedBatch(): BatchPublication {
        val completionBudgetMs = maxOf(1000, properties.publishTimeoutMs * 2)
        val workBudgetMs = TimeUnit.SECONDS.toMillis(properties.leaseSeconds) - completionBudgetMs
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(workBudgetMs)
        val now = OffsetDateTime.now(clock)
        val leaseUntil = now.plusSeconds(properties.leaseSeconds)
        val limit = minOf(properties.batchSize, properties.batchBytes / MAX_EVENT_BYTES)
        val rooms = observePhase(Stage.CLAIM) {
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
        if (rooms.isEmpty()) return BatchPublication(0, BatchOutcome.EMPTY)
        if (SendStageRecorder.isEnabled) {
            rooms.forEach { rows ->
                rows.forEach { row -> SendStageRecorder.record(SendStage.OUTBOX_CLAIM_COMMITTED, eventId = row.id.value) }
            }
        }
        metrics.claimed(rooms.sumOf { it.size })
        val prepared = observePhase(Stage.HYDRATE) {
            publisher.hydrate(rooms.flatten()).associateBy { it.id }
        }
        val published = Executors.newVirtualThreadPerTaskExecutor().use { executor ->
            val tasks = rooms.map { roomRows ->
                executor.submit(
                    Callable { publishClaimedRoom(roomRows.map { checkNotNull(prepared[it.id]) }, deadline) },
                )
            }
            tasks.map { it.get() }
        }
        val outcome = if (published.any { it.outcome == BatchOutcome.FAILED }) BatchOutcome.FAILED else BatchOutcome.WORK
        return BatchPublication(published.sumOf { it.completed }, outcome)
    }

    private fun publishClaimedRoom(
        rows: List<OutboxMessage>,
        deadline: Long,
    ): BatchPublication {
        val result = observePhase(Stage.PUBLISH, { it.outcome }) { publishRoom(rows = rows, deadline = deadline) }
        val completed = result.published
        if (completed.isNotEmpty()) {
            try {
                observePhase(Stage.COMPLETE) {
                    tx.observedExecuteWithoutResult(DatabaseTransaction.OUTBOX_COMPLETE) { repository.complete(completed, owner) }
                }
            } catch (error: Exception) {
                metrics.retained(RetentionReason.COMPLETE_FAILURE, completed.size)
                throw error
            }
        }
        val failed = result.outcome == PublicationOutcome.FAILURE || result.outcome == PublicationOutcome.CANCELLED
        return BatchPublication(completed.size, if (failed) BatchOutcome.FAILED else BatchOutcome.WORK)
    }

    private fun publishRoom(rows: List<OutboxMessage>, deadline: Long): RoomPublication {
        val published = ArrayList<EventId>(rows.size)
        for (row in rows) {
            if (Thread.currentThread().isInterrupted) {
                metrics.retained(RetentionReason.INTERRUPTED, rows.size - published.size)
                return RoomPublication(published, PublicationOutcome.CANCELLED)
            }
            if (deadline - System.nanoTime() < TimeUnit.MILLISECONDS.toNanos(properties.publishTimeoutMs)) {
                metrics.retained(RetentionReason.DEADLINE, rows.size - published.size)
                return RoomPublication(published, PublicationOutcome.DEADLINE)
            }
            val publishSample = metrics.started()
            var outcome = PublicationOutcome.FAILURE
            try {
                require(row.payload.toByteArray(StandardCharsets.UTF_8).size <= MAX_EVENT_BYTES) {
                    "Outbox event exceeds publication byte limit"
                }
                metrics.publicationAttempted(row, OffsetDateTime.now(clock))
                publisher.publish(message = row)
                outcome = PublicationOutcome.SUCCESS
                published.add(row.id)
                metrics.published()
            } catch (error: Exception) {
                metrics.publishFailed()
                log.error("Outbox publication failed for event {}", row.id, error)
                metrics.retained(RetentionReason.PUBLISH_FAILURE, rows.size - published.size)
                return RoomPublication(published, PublicationOutcome.FAILURE)
            } finally {
                metrics.publicationFinished(publishSample, outcome)
            }
        }
        return RoomPublication(published, PublicationOutcome.SUCCESS)
    }

    private inline fun <T> observePhase(
        phase: Stage,
        outcome: (T) -> PublicationOutcome = { PublicationOutcome.SUCCESS },
        action: () -> T,
    ): T {
        val sample = metrics.started()
        var result = PublicationOutcome.FAILURE
        try {
            return action().also { result = outcome(it) }
        } finally {
            metrics.stageFinished(sample, phase, result)
        }
    }
}
