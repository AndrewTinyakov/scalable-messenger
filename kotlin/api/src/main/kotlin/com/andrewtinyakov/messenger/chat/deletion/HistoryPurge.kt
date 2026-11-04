package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@Component
class HistoryPurge(
    private val repository: HistoryPurgeRepository,
    private val tx: TransactionTemplate,
    private val metrics: MeterRegistry,
    private val clock: Clock,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val pending = AtomicInteger()
    private val oldest = AtomicReference<OffsetDateTime?>()

    init {
        Gauge.builder("messenger.deletion.purge.pending", pending) { minOf(it.get(), 10000).toDouble() }.register(metrics)
        Gauge.builder("messenger.deletion.purge.pending.sample.capped", pending) { if (it.get() > 10000) 1.0 else 0.0 }.register(metrics)
        Gauge.builder("messenger.deletion.purge.oldest.seconds", oldest) { state ->
            state.get()?.let { maxOf(0, Duration.between(it, OffsetDateTime.now(clock)).seconds).toDouble() }
                ?: 0.0
        }.register(metrics)
    }

    fun runBatch(): Int? {
        val sample = Timer.start(metrics)
        var outcome = "failed"
        try {
            val removed = tx.observedExecute(DatabaseTransaction.DELETION_PURGE) { repository.purge(500) }
            outcome = if (removed == null) "empty" else "work"
            if (removed != null) metrics.counter("messenger.deletion.purged.rows").increment(removed.toDouble())
            return removed
        } catch (error: RuntimeException) {
            metrics.counter("messenger.deletion.purge.retries").increment()
            throw error
        } finally {
            metrics.counter("messenger.deletion.purge.results", "outcome", outcome).increment()
            sample.stop(
                Timer.builder("messenger.deletion.purge.batch").tag("outcome", outcome).publishPercentileHistogram()
                    .minimumExpectedValue(Duration.ofMillis(1)).maximumExpectedValue(Duration.ofSeconds(30)).register(metrics),
            )
        }
    }

    @Scheduled(fixedDelayString = "\${messenger.deletion.purge-delay-ms:1000}")
    fun tick() {
        try {
            for (attempt in 0 until 4) {
                if (runBatch() == null) break
            }
            repeat(2) { tx.observedExecute(DatabaseTransaction.DELETION_VISIBILITY_CLEANUP) { repository.cleanupPersonal(500) } }
        } catch (error: RuntimeException) {
            log.warn("History cleanup will retry", error)
        } finally {
            val backlog = repository.backlog()
            pending.set(backlog.sampledJobs)
            oldest.set(backlog.oldest)
        }
    }
}
