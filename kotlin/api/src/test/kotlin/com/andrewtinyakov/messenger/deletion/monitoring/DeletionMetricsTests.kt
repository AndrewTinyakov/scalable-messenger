package com.andrewtinyakov.messenger.deletion.monitoring

import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

class DeletionMetricsTests {
    private val clock = Clock.fixed(Instant.parse("2026-11-07T12:00:00Z"), ZoneOffset.UTC)
    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    private val metrics = DeletionMetrics(registry, clock)

    private fun assertScraped(vararg samples: String) {
        val scrape = registry.scrape()
        samples.forEach { sample -> assertTrue(scrape.contains(sample), "missing $sample") }
    }

    @Test
    fun `every series is exposed at zero before the first event`() {
        assertScraped(
            "messenger_deletion_acceptance_seconds_count{outcome=\"failed\",scope=\"everyone\",target=\"chat\"} 0",
            "messenger_deletion_acceptance_seconds_count{outcome=\"success\",scope=\"self\",target=\"messages\"} 0",
            "messenger_deletion_accepted_total{scope=\"everyone\",target=\"history\"} 0.0",
            "messenger_deletion_purged_rows_total 0.0",
            "messenger_deletion_purge_retries_total 0.0",
            "messenger_deletion_purge_results_total{outcome=\"empty\"} 0.0",
            "messenger_deletion_purge_results_total{outcome=\"failed\"} 0.0",
            "messenger_deletion_purge_results_total{outcome=\"work\"} 0.0",
            "messenger_deletion_purge_batch_seconds_count{outcome=\"work\"} 0",
            "messenger_deletion_purge_pending 0.0",
            "messenger_deletion_purge_pending_sample_capped 0.0",
            "messenger_deletion_purge_oldest_seconds 0.0",
        )
    }

    @Test
    fun `acceptance timing separates success from failure and counts only new requests`() {
        metrics.timeAcceptance(DeletionScope.SELF, DeletionTarget.MESSAGES) {
            metrics.accepted(DeletionScope.SELF, DeletionTarget.MESSAGES)
        }
        assertThrows(IllegalStateException::class.java) {
            metrics.timeAcceptance(DeletionScope.EVERYONE, DeletionTarget.CHAT) { error("rejected") }
        }

        assertScraped(
            "messenger_deletion_acceptance_seconds_count{outcome=\"success\",scope=\"self\",target=\"messages\"} 1",
            "messenger_deletion_acceptance_seconds_count{outcome=\"failed\",scope=\"everyone\",target=\"chat\"} 1",
            "messenger_deletion_accepted_total{scope=\"self\",target=\"messages\"} 1.0",
            "messenger_deletion_accepted_total{scope=\"everyone\",target=\"chat\"} 0.0",
        )
    }

    @Test
    fun `purge batches record rows outcomes and retries`() {
        metrics.timePurgeBatch { 120 }
        metrics.timePurgeBatch { null }
        assertThrows(IllegalStateException::class.java) { metrics.timePurgeBatch { error("database unavailable") } }

        assertScraped(
            "messenger_deletion_purged_rows_total 120.0",
            "messenger_deletion_purge_results_total{outcome=\"work\"} 1.0",
            "messenger_deletion_purge_results_total{outcome=\"empty\"} 1.0",
            "messenger_deletion_purge_results_total{outcome=\"failed\"} 1.0",
            "messenger_deletion_purge_retries_total 1.0",
            "messenger_deletion_purge_batch_seconds_count{outcome=\"failed\"} 1",
        )
    }

    @Test
    fun `purge backlog caps the pending sample and ages the oldest job`() {
        metrics.purgeBacklog(10001, OffsetDateTime.now(clock).minusMinutes(3))

        assertScraped(
            "messenger_deletion_purge_pending 10000.0",
            "messenger_deletion_purge_pending_sample_capped 1.0",
            "messenger_deletion_purge_oldest_seconds 180.0",
        )
    }
}
