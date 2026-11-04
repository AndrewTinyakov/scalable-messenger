package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import io.micrometer.core.instrument.MeterRegistry
import org.jooq.DSLContext
import org.jooq.impl.DSL.count
import org.jooq.impl.DSL.min
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong

@Component
class OutboxBacklogMetrics(
    private val db: DSLContext,
    metrics: MeterRegistry,
    private val clock: Clock,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val pending = AtomicLong()
    private val oldestCreatedAt = AtomicLong()
    private val sampleHealthy = AtomicLong()
    private val failures = metrics.counter("messenger.outbox.backlog.sample.failures")

    init {
        metrics.gauge("messenger.outbox.pending", pending)
        metrics.gauge("messenger.outbox.oldest.age.seconds", oldestCreatedAt) { timestamp ->
            val oldest = timestamp.get()
            if (oldest == 0L) 0.0 else (Instant.now(clock).epochSecond - oldest).coerceAtLeast(0).toDouble()
        }
        metrics.gauge("messenger.outbox.backlog.sample.healthy", sampleHealthy)
    }

    @Scheduled(fixedDelay = 15000)
    fun sample() {
        try {
            val row = DatabaseObservation.query(DatabaseOperation.OUTBOX_BACKLOG_SAMPLE) {
                db.select(count(), min(MESSENGER_OUTBOX_EVENTS.CREATED_AT))
                    .from(MESSENGER_OUTBOX_EVENTS)
                    .where(MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull)
                    .fetchOne()
            } ?: return
            pending.set(row.value1().toLong())
            oldestCreatedAt.set(row.value2()?.toEpochSecond() ?: 0L)
            sampleHealthy.set(1)
        } catch (error: Exception) {
            sampleHealthy.set(0)
            failures.increment()
            log.warn("Could not sample outbox backlog", error)
        }
    }
}
