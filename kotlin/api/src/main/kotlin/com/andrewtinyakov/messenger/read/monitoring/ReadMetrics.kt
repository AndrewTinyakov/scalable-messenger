package com.andrewtinyakov.messenger.read.monitoring

import com.andrewtinyakov.messenger.read.model.ReadCleanup
import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.function.Supplier

@Component
class ReadMetrics(
    registry: MeterRegistry,
) {
    private val advancedRequests = registry.describedCounter(ADVANCES, ADVANCES_DESCRIPTION, "outcome", "advanced")
    private val unchangedRequests = registry.describedCounter(ADVANCES, ADVANCES_DESCRIPTION, "outcome", "unchanged")
    private val insertedRanges = registry.describedCounter(
        "messenger.read.ranges.inserted",
        "Read timestamp ranges written by advanced progress.",
    )
    private val emittedNotifications = registry.describedCounter(NOTIFICATIONS, NOTIFICATIONS_DESCRIPTION, "outcome", "emitted")
    private val coalescedNotifications = registry.describedCounter(NOTIFICATIONS, NOTIFICATIONS_DESCRIPTION, "outcome", "coalesced")
    private val servedDetails = registry.describedCounter(DETAILS, DETAILS_DESCRIPTION, "outcome", "served")
    private val expiredDetails = registry.describedCounter(DETAILS, DETAILS_DESCRIPTION, "outcome", "expired")
    private val detailRows = registry.describedCounter("messenger.read.details.rows", "Reader rows returned by message read details.")
    private val completedCleanups = registry.describedCounter(CLEANUP_BATCHES, CLEANUP_BATCHES_DESCRIPTION, "outcome", "completed")
    private val busyCleanups = registry.describedCounter(CLEANUP_BATCHES, CLEANUP_BATCHES_DESCRIPTION, "outcome", "busy")
    private val failedCleanups = registry.describedCounter(CLEANUP_BATCHES, CLEANUP_BATCHES_DESCRIPTION, "outcome", "failed")
    private val cleanedRanges = registry.describedCounter(CLEANUP_ROWS, CLEANUP_ROWS_DESCRIPTION, "kind", "ranges")
    private val cleanedNotifications = registry.describedCounter(CLEANUP_ROWS, CLEANUP_ROWS_DESCRIPTION, "kind", "notifications")
    private val cleanupDuration = Timer.builder("messenger.read.cleanup.duration")
        .description("Duration of one expired read timestamp cleanup batch.")
        .publishPercentileHistogram()
        .minimumExpectedValue(Duration.ofMillis(1))
        .maximumExpectedValue(Duration.ofMinutes(1))
        .register(registry)
    private val cleanupBacklog = AtomicInteger()
    private val oldestExpiredAgeSeconds = AtomicLong()

    init {
        Gauge.builder("messenger.read.cleanup.backlog", cleanupBacklog, AtomicInteger::toDouble)
            .description("Expired read timestamp ranges left after the last cleanup batch.")
            .register(registry)
        Gauge.builder("messenger.read.cleanup.oldest.age", oldestExpiredAgeSeconds, AtomicLong::toDouble)
            .description("Age of the oldest expired read timestamp range left after the last cleanup batch.")
            .baseUnit("seconds")
            .register(registry)
    }

    fun advanced(rangesWritten: Int, notificationCoalesced: Boolean) {
        advancedRequests.increment()
        insertedRanges.increment(rangesWritten.toDouble())
        if (notificationCoalesced) coalescedNotifications.increment() else emittedNotifications.increment()
    }

    fun unchanged() = unchangedRequests.increment()

    fun detailsServed(rows: Int) {
        servedDetails.increment()
        detailRows.increment(rows.toDouble())
    }

    fun detailsExpired() = expiredDetails.increment()

    fun <T> timeCleanup(action: () -> T): T = cleanupDuration.record(Supplier(action))

    fun cleanupCompleted(cleanup: ReadCleanup, oldestExpiredAge: Duration) {
        completedCleanups.increment()
        cleanedRanges.increment(cleanup.ranges.toDouble())
        cleanedNotifications.increment(cleanup.notifications.toDouble())
        cleanupBacklog.set(cleanup.backlog)
        oldestExpiredAgeSeconds.set(oldestExpiredAge.seconds.coerceAtLeast(0))
    }

    fun cleanupBusy() = busyCleanups.increment()

    fun cleanupFailed() = failedCleanups.increment()

    private companion object {
        const val ADVANCES = "messenger.read.advances"
        const val ADVANCES_DESCRIPTION = "Committed read progress requests by whether the account frontier moved."
        const val NOTIFICATIONS = "messenger.read.notifications"
        const val NOTIFICATIONS_DESCRIPTION = "Shared read invalidations emitted immediately or coalesced into the current bucket."
        const val DETAILS = "messenger.read.details"
        const val DETAILS_DESCRIPTION = "Message read detail requests by whether timestamps were still retained."
        const val CLEANUP_BATCHES = "messenger.read.cleanup.batches"
        const val CLEANUP_BATCHES_DESCRIPTION = "Expired read timestamp cleanup batches by outcome."
        const val CLEANUP_ROWS = "messenger.read.cleanup.rows"
        const val CLEANUP_ROWS_DESCRIPTION = "Rows removed by expired read timestamp cleanup."

        fun MeterRegistry.describedCounter(name: String, description: String, vararg tags: String): Counter =
            Counter.builder(name).description(description).tags(*tags).register(this)
    }
}
