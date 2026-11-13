package com.andrewtinyakov.messenger.infrastructure.outbox.monitoring

import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

@Component
class OutboxMetrics(
    registry: MeterRegistry,
    private val clock: Clock,
) {
    enum class BatchOutcome(
        val metricValue: String,
    ) {
        EMPTY("empty"),
        WORK("work"),
        FAILED("failed"),
    }

    enum class PublicationOutcome(
        val metricValue: String,
    ) {
        SUCCESS("success"),
        FAILURE("failure"),
    }

    enum class StageOutcome(
        val metricValue: String,
    ) {
        SUCCESS("success"),
        FAILURE("failure"),
        DEADLINE("deadline"),
        CANCELLED("cancelled"),
    }

    enum class Stage(
        val metricValue: String,
    ) {
        CLAIM("claim"),
        HYDRATE("hydrate"),
        PUBLISH("publish"),
        COMPLETE("complete"),
    }

    enum class RetentionReason(
        val metricValue: String,
    ) {
        COMPLETE_FAILURE("complete_failure"),
        INTERRUPTED("interrupted"),
        DEADLINE("deadline"),
        PUBLISH_FAILURE("publish_failure"),
    }

    private enum class RoomKind(
        val metricValue: String,
    ) {
        GROUP("group"),
        USER("user"),
    }

    private enum class InvalidAge(
        val metricValue: String,
    ) {
        MISSING("missing"),
        FUTURE("future"),
    }

    private val pending = AtomicLong()
    private val oldestCreatedAt = AtomicLong()
    private val sampleHealthy = AtomicLong()
    private val sampleFailures = registry.describedCounter(
        "messenger.outbox.backlog.sample.failures",
        "Failed database samples of the pending outbox backlog.",
    )
    private val claimed = registry.describedCounter("messenger.outbox.claimed", "Outbox events claimed by committed lease transactions.")
    private val published = registry.describedCounter(
        "messenger.outbox.publish",
        "Outbox transport publication attempts by result.",
        "result",
        "success",
    )
    private val publishFailures = registry.describedCounter(
        "messenger.outbox.publish",
        "Outbox transport publication attempts by result.",
        "result",
        "failure",
    )
    private val retained = RetentionReason.entries.associateWith {
        registry.describedCounter("messenger.outbox.retained", "Outbox events left pending for retry by reason.", "reason", it.metricValue)
    }
    private val batches = BatchOutcome.entries.associateWith {
        Timer.builder("messenger.outbox.batch").description("Duration of an outbox publication batch by outcome.")
            .tag("outcome", it.metricValue).register(registry)
    }
    private val publications = PublicationOutcome.entries.associateWith {
        registry.histogram(
            "messenger.outbox.publication",
            "Duration of an outbox transport publication attempt.",
            "outcome",
            it.metricValue,
        )
    }
    private val stages = Stage.entries.flatMap { stage ->
        val outcomes = when (stage) {
            Stage.PUBLISH -> StageOutcome.entries
            else -> listOf(StageOutcome.SUCCESS, StageOutcome.FAILURE)
        }
        outcomes.map { outcome ->
            (stage to outcome) to registry.histogram(
                "messenger.outbox.stage",
                "Duration of an outbox publication stage by outcome.",
                "phase",
                stage.metricValue,
                "outcome",
                outcome.metricValue,
            )
        }
    }.toMap()
    private val publicationAges = RoomKind.entries.associateWith {
        Timer.builder("messenger.outbox.publication.age").description("Age of an outbox event before a transport publication attempt.")
            .tag("room_kind", it.metricValue).serviceLevelObjectives(*PUBLICATION_AGE_BUCKETS).register(registry)
    }
    private val invalidAges = RoomKind.entries.flatMap { room ->
        InvalidAge.entries.map { reason ->
            (room to reason) to registry.describedCounter(
                "messenger.outbox.publication.age.invalid",
                "Outbox publication attempts without a valid creation timestamp.",
                "room_kind",
                room.metricValue,
                "reason",
                reason.metricValue,
            )
        }
    }.toMap()

    init {
        Gauge.builder("messenger.outbox.pending", pending, AtomicLong::toDouble)
            .description("Pending outbox events at the last successful database sample.").register(registry)
        Gauge.builder("messenger.outbox.oldest.age.seconds", oldestCreatedAt) { timestamp ->
            val oldest = timestamp.get()
            if (oldest == 0L) 0.0 else (Instant.now(clock).epochSecond - oldest).coerceAtLeast(0).toDouble()
        }.description("Current age of the oldest event from the last successful outbox backlog sample.")
            .baseUnit("seconds").register(registry)
        Gauge.builder("messenger.outbox.backlog.sample.healthy", sampleHealthy, AtomicLong::toDouble)
            .description("Whether the most recent outbox backlog sample succeeded.").register(registry)
    }

    fun backlogSampled(count: Long, oldest: OffsetDateTime?) {
        pending.set(count)
        oldestCreatedAt.set(oldest?.toEpochSecond() ?: 0L)
        sampleHealthy.set(1)
    }

    fun backlogSampleFailed() {
        sampleHealthy.set(0)
        sampleFailures.increment()
    }

    fun claimed(count: Int) = claimed.increment(count.toDouble())

    fun retained(reason: RetentionReason, count: Int) = retained.getValue(reason).increment(count.toDouble())

    fun started(): Long = System.nanoTime()

    fun batchFinished(started: Long, outcome: BatchOutcome) = batches.getValue(outcome).recordSince(started)

    fun stageFinished(started: Long, stage: Stage, outcome: StageOutcome) = stages.getValue(stage to outcome).recordSince(started)

    fun published() = published.increment()

    fun publishFailed() = publishFailures.increment()

    fun publicationFinished(started: Long, outcome: PublicationOutcome) = publications.getValue(outcome).recordSince(started)

    fun publicationAttempted(row: OutboxMessage, now: OffsetDateTime) {
        try {
            val room = if (RoomAddress.isGroup(row.room)) RoomKind.GROUP else RoomKind.USER
            val age = row.createdAt?.let { Duration.between(it, now) }
            if (age == null || age.isNegative) {
                invalidAges.getValue(room to if (age == null) InvalidAge.MISSING else InvalidAge.FUTURE).increment()
            } else {
                publicationAges.getValue(room).record(age)
            }
        } catch (_: RuntimeException) {
        }
    }

    private fun Timer.recordSince(started: Long) = record(System.nanoTime() - started, TimeUnit.NANOSECONDS)

    private companion object {
        val PUBLICATION_AGE_BUCKETS = longArrayOf(1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)
            .map(Duration::ofMillis).toTypedArray()

        fun MeterRegistry.describedCounter(name: String, description: String, vararg tags: String): Counter =
            Counter.builder(name).description(description).tags(*tags).register(this)

        fun MeterRegistry.histogram(name: String, description: String, vararg tags: String): Timer =
            Timer.builder(name).description(description).tags(*tags)
                .publishPercentileHistogram().minimumExpectedValue(Duration.ofMillis(1))
                .maximumExpectedValue(Duration.ofMinutes(2)).register(this)
    }
}
