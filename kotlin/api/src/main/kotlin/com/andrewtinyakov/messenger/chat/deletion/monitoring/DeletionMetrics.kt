package com.andrewtinyakov.messenger.chat.deletion.monitoring

import com.andrewtinyakov.messenger.chat.deletion.web.payload.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.web.payload.DeletionTarget
import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@Component
class DeletionMetrics(
    registry: MeterRegistry,
    private val clock: Clock,
) {
    private val acceptance = DeletionScope.entries.flatMap { scope ->
        DeletionTarget.entries.flatMap { target ->
            listOf(SUCCESS, FAILED).map { outcome ->
                Triple(scope, target, outcome) to Timer.builder("messenger.deletion.acceptance")
                    .description("Duration of accepting a deletion request, including idempotent replays.")
                    .tags("scope", scope.metricValue(), "target", target.metricValue(), "outcome", outcome)
                    .publishPercentileHistogram()
                    .minimumExpectedValue(Duration.ofMillis(1))
                    .maximumExpectedValue(Duration.ofSeconds(30))
                    .register(registry)
            }
        }
    }.toMap()
    private val accepted = DeletionScope.entries.flatMap { scope ->
        DeletionTarget.entries.map { target ->
            (scope to target) to Counter.builder("messenger.deletion.accepted")
                .description("Newly committed deletion requests.")
                .tags("scope", scope.metricValue(), "target", target.metricValue())
                .register(registry)
        }
    }.toMap()
    private val purgedRows = Counter.builder("messenger.deletion.purged.rows")
        .description("Message rows removed by history purge batches.")
        .register(registry)
    private val purgeRetries = Counter.builder("messenger.deletion.purge.retries")
        .description("History purge batches that failed and will be retried.")
        .register(registry)
    private val purgeResults = PurgeOutcome.entries.associateWith { outcome ->
        Counter.builder("messenger.deletion.purge.results")
            .description("History purge batches by outcome.")
            .tag("outcome", outcome.metricValue())
            .register(registry)
    }
    private val purgeBatches = PurgeOutcome.entries.associateWith { outcome ->
        Timer.builder("messenger.deletion.purge.batch")
            .description("Duration of one history purge batch.")
            .tag("outcome", outcome.metricValue())
            .publishPercentileHistogram()
            .minimumExpectedValue(Duration.ofMillis(1))
            .maximumExpectedValue(Duration.ofSeconds(30))
            .register(registry)
    }
    private val pendingJobs = AtomicInteger()
    private val oldestJob = AtomicReference<OffsetDateTime?>()

    init {
        Gauge.builder("messenger.deletion.purge.pending", pendingJobs) { minOf(it.get(), PENDING_SAMPLE_CAP).toDouble() }
            .description("Sampled history purge jobs, capped at $PENDING_SAMPLE_CAP.")
            .register(registry)
        Gauge.builder("messenger.deletion.purge.pending.sample.capped", pendingJobs) { if (it.get() > PENDING_SAMPLE_CAP) 1.0 else 0.0 }
            .description("Whether the history purge job sample reached its cap.")
            .register(registry)
        Gauge.builder("messenger.deletion.purge.oldest.seconds", oldestJob) { state ->
            state.get()?.let { maxOf(0, Duration.between(it, OffsetDateTime.now(clock)).seconds).toDouble() } ?: 0.0
        }
            .description("Age of the oldest pending history purge job.")
            .register(registry)
    }

    fun <T> timeAcceptance(scope: DeletionScope, target: DeletionTarget, acceptance: () -> T): T {
        val started = System.nanoTime()
        var outcome = FAILED
        try {
            return acceptance().also { outcome = SUCCESS }
        } finally {
            this.acceptance.getValue(Triple(scope, target, outcome)).record(System.nanoTime() - started, TimeUnit.NANOSECONDS)
        }
    }

    fun accepted(scope: DeletionScope, target: DeletionTarget) = accepted.getValue(scope to target).increment()

    fun timePurgeBatch(batch: () -> Int?): Int? {
        val started = System.nanoTime()
        val removed = try {
            batch()
        } catch (failure: RuntimeException) {
            purgeRetries.increment()
            purgeFinished(PurgeOutcome.FAILED, started)
            throw failure
        }
        if (removed != null) purgedRows.increment(removed.toDouble())
        purgeFinished(if (removed == null) PurgeOutcome.EMPTY else PurgeOutcome.WORK, started)
        return removed
    }

    fun purgeBacklog(sampledJobs: Int, oldest: OffsetDateTime?) {
        pendingJobs.set(sampledJobs)
        oldestJob.set(oldest)
    }

    private fun purgeFinished(outcome: PurgeOutcome, started: Long) {
        purgeResults.getValue(outcome).increment()
        purgeBatches.getValue(outcome).record(System.nanoTime() - started, TimeUnit.NANOSECONDS)
    }

    private enum class PurgeOutcome { EMPTY, WORK, FAILED }

    private companion object {
        const val SUCCESS = "success"
        const val FAILED = "failed"
        const val PENDING_SAMPLE_CAP = 10000

        fun Enum<*>.metricValue(): String = name.lowercase()
    }
}
