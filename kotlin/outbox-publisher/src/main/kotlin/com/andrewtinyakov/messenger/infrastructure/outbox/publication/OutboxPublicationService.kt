package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.MAX_EVENT_BYTES
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxClaimRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublisherProperties
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxBatchOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxMetrics
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxPublicationOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxRetentionReason
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxStage
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxStageOutcome
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
    private val properties: OutboxPublisherProperties,
) {
    private val owner = UUID.randomUUID().toString()
    private val logger = LoggerFactory.getLogger(javaClass)

    @Synchronized
    fun publishBatch(): Int {
        val sample = metrics.started()
        var outcome = OutboxBatchOutcome.FAILED
        try {
            val result = publishClaimedBatch()
            outcome = result.outcome
            return result.completed
        } finally {
            metrics.batchFinished(sample, outcome)
        }
    }

    private fun publishClaimedBatch(): BatchPublication {
        val deadline = workDeadline()
        val rooms = claimRooms()
        if (rooms.isEmpty()) return BatchPublication(0, OutboxBatchOutcome.EMPTY)
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
        return observePhase(OutboxStage.CLAIM) {
            tx.execute { claimAnchorsWithGroupTails(now, leaseUntil, limit) }
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

    private fun hydrate(rooms: List<List<OutboxMessage>>): Map<EventId, OutboxMessage> = observePhase(OutboxStage.HYDRATE) {
        outboxEventPublisher.hydrate(rooms.flatten()).associateBy { it.id }
    }

    private fun publishRooms(
        rooms: List<List<OutboxMessage>>,
        prepared: Map<EventId, OutboxMessage>,
        deadline: Long,
    ): List<BatchPublication> {
        val completion = GroupCompletion { ids -> tx.executeWithoutResult { outboxClaimRepository.complete(ids, owner) } }
        return Executors.newThreadPerTaskExecutor(Thread.ofVirtual().name("outbox-publication").factory()).use { executor ->
            val tasks = rooms.map { roomRows ->
                executor.submit(
                    Callable { publishClaimedRoom(roomRows.map { checkNotNull(prepared[it.id]) }, deadline, completion) },
                )
            }
            tasks.map { it.get() }
        }
    }

    private fun summarize(published: List<BatchPublication>): BatchPublication {
        val outcome = if (published.any { it.outcome == OutboxBatchOutcome.FAILED }) OutboxBatchOutcome.FAILED else OutboxBatchOutcome.WORK
        return BatchPublication(published.sumOf { it.completed }, outcome)
    }

    private fun publishClaimedRoom(
        rows: List<OutboxMessage>,
        deadline: Long,
        completion: GroupCompletion,
    ): BatchPublication {
        val result = observePhase(OutboxStage.PUBLISH, { it.outcome }) { publishRoom(rows = rows, deadline = deadline) }
        val completed = result.published
        if (completed.isNotEmpty()) {
            try {
                observePhase(OutboxStage.COMPLETE) { completion.complete(completed) }
            } catch (error: Exception) {
                metrics.retained(OutboxRetentionReason.COMPLETE_FAILURE, completed.size)
                throw error
            }
        }
        val failed = result.outcome == OutboxStageOutcome.FAILURE || result.outcome == OutboxStageOutcome.CANCELLED
        return BatchPublication(completed.size, if (failed) OutboxBatchOutcome.FAILED else OutboxBatchOutcome.WORK)
    }

    private fun publishRoom(rows: List<OutboxMessage>, deadline: Long): RoomPublication {
        val published = ArrayList<EventId>(rows.size)
        for (row in rows) {
            if (Thread.currentThread().isInterrupted) {
                metrics.retained(OutboxRetentionReason.INTERRUPTED, rows.size - published.size)
                return RoomPublication(published, OutboxStageOutcome.CANCELLED)
            }
            if (deadline - System.nanoTime() < properties.publishTimeout.toNanos()) {
                metrics.retained(OutboxRetentionReason.DEADLINE, rows.size - published.size)
                return RoomPublication(published, OutboxStageOutcome.DEADLINE)
            }
            val publishSample = metrics.started()
            var outcome = OutboxPublicationOutcome.FAILURE
            try {
                require(row.payload.toByteArray(StandardCharsets.UTF_8).size <= MAX_EVENT_BYTES) {
                    "Outbox event exceeds publication byte limit"
                }
                metrics.publicationAttempted(row, OffsetDateTime.now(clock))
                outboxEventPublisher.publish(message = row)
                outcome = OutboxPublicationOutcome.SUCCESS
                published.add(row.id)
                metrics.published()
            } catch (error: Exception) {
                metrics.publishFailed()
                logger.error("Outbox publication failed for event {}", row.id, error)
                metrics.retained(OutboxRetentionReason.PUBLISH_FAILURE, rows.size - published.size)
                return RoomPublication(published, OutboxStageOutcome.FAILURE)
            } finally {
                metrics.publicationFinished(publishSample, outcome)
            }
        }
        return RoomPublication(published, OutboxStageOutcome.SUCCESS)
    }

    private inline fun <T> observePhase(
        phase: OutboxStage,
        outcome: (T) -> OutboxStageOutcome = { OutboxStageOutcome.SUCCESS },
        action: () -> T,
    ): T {
        val sample = metrics.started()
        var result = OutboxStageOutcome.FAILURE
        try {
            return action().also { result = outcome(it) }
        } finally {
            metrics.stageFinished(sample, phase, result)
        }
    }
}
