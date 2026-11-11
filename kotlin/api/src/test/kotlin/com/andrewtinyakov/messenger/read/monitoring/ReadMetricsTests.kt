package com.andrewtinyakov.messenger.read.monitoring

import com.andrewtinyakov.messenger.read.model.ReadCleanup
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Duration

class ReadMetricsTests {
    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    private val metrics = ReadMetrics(registry)

    private fun assertScraped(vararg samples: String) {
        val scrape = registry.scrape()
        samples.forEach { sample -> assertTrue(scrape.contains(sample), "missing $sample") }
    }

    @Test
    fun `every series is exposed at zero before the first event`() {
        assertScraped(
            "messenger_read_advances_total{outcome=\"advanced\"} 0.0",
            "messenger_read_advances_total{outcome=\"unchanged\"} 0.0",
            "messenger_read_ranges_inserted_total 0.0",
            "messenger_read_notifications_total{outcome=\"coalesced\"} 0.0",
            "messenger_read_notifications_total{outcome=\"emitted\"} 0.0",
            "messenger_read_details_total{outcome=\"expired\"} 0.0",
            "messenger_read_details_total{outcome=\"served\"} 0.0",
            "messenger_read_details_rows_total 0.0",
            "messenger_read_cleanup_batches_total{outcome=\"busy\"} 0.0",
            "messenger_read_cleanup_batches_total{outcome=\"completed\"} 0.0",
            "messenger_read_cleanup_batches_total{outcome=\"failed\"} 0.0",
            "messenger_read_cleanup_rows_total{kind=\"notifications\"} 0.0",
            "messenger_read_cleanup_rows_total{kind=\"ranges\"} 0.0",
            "messenger_read_cleanup_duration_seconds_count 0",
            "messenger_read_cleanup_backlog 0.0",
            "messenger_read_cleanup_oldest_age_seconds 0.0",
        )
    }

    @Test
    fun `read progress records ranges and notification coalescing per advance`() {
        metrics.advanced(rangesWritten = 3, notificationCoalesced = false)
        metrics.advanced(rangesWritten = 2, notificationCoalesced = true)
        metrics.unchanged()

        assertScraped(
            "messenger_read_advances_total{outcome=\"advanced\"} 2.0",
            "messenger_read_advances_total{outcome=\"unchanged\"} 1.0",
            "messenger_read_ranges_inserted_total 5.0",
            "messenger_read_notifications_total{outcome=\"coalesced\"} 1.0",
            "messenger_read_notifications_total{outcome=\"emitted\"} 1.0",
        )
    }

    @Test
    fun `reader details count requests separately from returned rows`() {
        metrics.detailsServed(rows = 4)
        metrics.detailsServed(rows = 0)
        metrics.detailsExpired()

        assertScraped(
            "messenger_read_details_total{outcome=\"served\"} 2.0",
            "messenger_read_details_total{outcome=\"expired\"} 1.0",
            "messenger_read_details_rows_total 4.0",
        )
    }

    @Test
    fun `cleanup records batch outcomes rows backlog and clamped expiry age`() {
        metrics.timeCleanup { metrics.cleanupCompleted(ReadCleanup(7, 2, 40, null), Duration.ofSeconds(90)) }
        metrics.cleanupBusy()
        metrics.cleanupFailed()

        assertScraped(
            "messenger_read_cleanup_batches_total{outcome=\"completed\"} 1.0",
            "messenger_read_cleanup_batches_total{outcome=\"busy\"} 1.0",
            "messenger_read_cleanup_batches_total{outcome=\"failed\"} 1.0",
            "messenger_read_cleanup_rows_total{kind=\"ranges\"} 7.0",
            "messenger_read_cleanup_rows_total{kind=\"notifications\"} 2.0",
            "messenger_read_cleanup_duration_seconds_count 1",
            "messenger_read_cleanup_backlog 40.0",
            "messenger_read_cleanup_oldest_age_seconds 90.0",
        )

        metrics.cleanupCompleted(ReadCleanup(0, 0, 0, null), Duration.ofSeconds(-5))

        assertScraped("messenger_read_cleanup_oldest_age_seconds 0.0")
    }
}
