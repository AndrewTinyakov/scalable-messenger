package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMetrics.BatchOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMetrics.PublicationOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMetrics.RetentionReason
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMetrics.Stage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMetrics.StageOutcome
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors

private val MIN_COMPLETION_BUDGET = Duration.ofSeconds(1)

@Service
class OutboxPublicationService(
    private val outboxClaimRepository: OutboxClaimRepository,
    private val tx: TransactionTemplate,
    private val outboxEventPublisher: OutboxEventPublisher,
    private val metrics: OutboxMetrics,
    private val clock: Clock,
    private val properties: PublisherProperties,
) {
    private val owner = UUID.randomUUID().toString()
    private val logger = LoggerFactory.getLogger(javaClass)

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
        val outcome: StageOutcome,
    )

    private fun publishClaimedBatch(): BatchPublication {
        val deadline = workDeadline()
        val rooms = claimRooms()
        if (rooms.isEmpty()) return BatchPublication(0, BatchOutcome.EMPTY)
        recordClaimed(rooms)
        val prepared = hydrate(rooms)
        val published = publishRooms(rooms, prepared, deadline)
        return summarize(published)
    }

    private fun workDeadline(): Long {
        val completionBudget = maxOf(MIN_COMPLETION_BUDGET, properties.publishTimeout.multipliedBy(2))
        return System.nanoTime() + properties.lease.minus(completionBudget).toNanos()
    }

    private fun claimRooms(): List<List<OutboxMessage>> {
        val now = OffsetDateTime.now(clock)
        val leaseUntil = now.plus(properties.lease)
        val limit = minOf(properties.batchSize, properties.batchBytes / MAX_EVENT_BYTES)
        return observePhase(Stage.CLAIM) {
            tx.observedExecute(DatabaseTransaction.OUTBOX_CLAIM) { claimAnchorsWithGroupTails(now, leaseUntil, limit) }
        }
    }

    private fun claimAnchorsWithGroupTails(now: OffsetDateTime, leaseUntil: OffsetDateTime, limit: Int): List<List<OutboxMessage>> {
        val anchors = outboxClaimRepository.claim(now, minOf(limit, properties.concurrency), owner, leaseUntil)
        var remaining = limit - anchors.size
        return anchors.groupBy { it.room }.values.map { roomAnchors ->
            val tail = claimGroupTail(roomAnchors, remaining, leaseUntil)
            remaining -= tail.size
            roomAnchors + tail
        }
    }

    private fun claimGroupTail(roomAnchors: List<OutboxMessage>, remaining: Int, leaseUntil: OffsetDateTime): List<OutboxMessage> {
        val anchor = roomAnchors.first()
        val wanted = if (anchor.groupPublicationOrder != null) properties.roomBatchSize - roomAnchors.size else 0
        if (wanted <= 0 || remaining <= 0) return emptyList()
        return outboxClaimRepository.claimGroupTail(anchor, OffsetDateTime.now(clock), minOf(wanted, remaining), owner, leaseUntil)
    }

    private fun recordClaimed(rooms: List<List<OutboxMessage>>) {
        if (SendStageRecorder.isEnabled) {
            rooms.forEach { rows ->
                rows.forEach { row -> SendStageRecorder.record(SendStage.OUTBOX_CLAIM_COMMITTED, eventId = row.id.value) }
            }
        }
        metrics.claimed(rooms.sumOf { it.size })
    }

    private fun hydrate(rooms: List<List<OutboxMessage>>): Map<EventId, OutboxMessage> = observePhase(Stage.HYDRATE) {
        outboxEventPublisher.hydrate(rooms.flatten()).associateBy { it.id }
    }

    private fun publishRooms(
        rooms: List<List<OutboxMessage>>,
        prepared: Map<EventId, OutboxMessage>,
        deadline: Long,
    ): List<BatchPublication> = Executors.newVirtualThreadPerTaskExecutor().use { executor ->
        val tasks = rooms.map { roomRows ->
            executor.submit(
                Callable { publishClaimedRoom(roomRows.map { checkNotNull(prepared[it.id]) }, deadline) },
            )
        }
        tasks.map { it.get() }
    }

    private fun summarize(published: List<BatchPublication>): BatchPublication {
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
                    tx.observedExecuteWithoutResult(DatabaseTransaction.OUTBOX_COMPLETE) {
                        outboxClaimRepository.complete(completed, owner)
                    }
                }
            } catch (error: Exception) {
                metrics.retained(RetentionReason.COMPLETE_FAILURE, completed.size)
                throw error
            }
        }
        val failed = result.outcome == StageOutcome.FAILURE || result.outcome == StageOutcome.CANCELLED
        return BatchPublication(completed.size, if (failed) BatchOutcome.FAILED else BatchOutcome.WORK)
    }

    private fun publishRoom(rows: List<OutboxMessage>, deadline: Long): RoomPublication {
        val published = ArrayList<EventId>(rows.size)
        for (row in rows) {
            if (Thread.currentThread().isInterrupted) {
                metrics.retained(RetentionReason.INTERRUPTED, rows.size - published.size)
                return RoomPublication(published, StageOutcome.CANCELLED)
            }
            if (deadline - System.nanoTime() < properties.publishTimeout.toNanos()) {
                metrics.retained(RetentionReason.DEADLINE, rows.size - published.size)
                return RoomPublication(published, StageOutcome.DEADLINE)
            }
            val publishSample = metrics.started()
            var outcome = PublicationOutcome.FAILURE
            try {
                require(row.payload.toByteArray(StandardCharsets.UTF_8).size <= MAX_EVENT_BYTES) {
                    "Outbox event exceeds publication byte limit"
                }
                metrics.publicationAttempted(row, OffsetDateTime.now(clock))
                outboxEventPublisher.publish(message = row)
                outcome = PublicationOutcome.SUCCESS
                published.add(row.id)
                metrics.published()
            } catch (error: Exception) {
                metrics.publishFailed()
                logger.error("Outbox publication failed for event {}", row.id, error)
                metrics.retained(RetentionReason.PUBLISH_FAILURE, rows.size - published.size)
                return RoomPublication(published, StageOutcome.FAILURE)
            } finally {
                metrics.publicationFinished(publishSample, outcome)
            }
        }
        return RoomPublication(published, StageOutcome.SUCCESS)
    }

    private inline fun <T> observePhase(
        phase: Stage,
        outcome: (T) -> StageOutcome = { StageOutcome.SUCCESS },
        action: () -> T,
    ): T {
        val sample = metrics.started()
        var result = StageOutcome.FAILURE
        try {
            return action().also { result = outcome(it) }
        } finally {
            metrics.stageFinished(sample, phase, result)
        }
    }
}
