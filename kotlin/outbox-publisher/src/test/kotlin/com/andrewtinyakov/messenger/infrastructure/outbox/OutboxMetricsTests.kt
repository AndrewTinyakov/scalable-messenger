package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxBatchOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxMetrics
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxPublicationOutcome
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxRetentionReason
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxStage
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxStageOutcome
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import java.time.Clock
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.concurrent.TimeUnit

class OutboxMetricsTests {
    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    private val clock = mock(Clock::class.java)
    private val now = Instant.parse("2026-11-03T12:00:00Z")
    private val metrics = OutboxMetrics(registry, clock)

    init {
        `when`(clock.instant()).thenReturn(now)
    }

    @Test
    fun `all closed label combinations are exposed before the first event`() {
        assertScraped(
            "messenger_outbox_pending 0.0",
            "messenger_outbox_oldest_age_seconds 0.0",
            "messenger_outbox_backlog_sample_healthy 0.0",
            "messenger_outbox_backlog_sample_failures_total 0.0",
            "messenger_outbox_claimed_total 0.0",
            "messenger_outbox_publish_total{result=\"success\"} 0.0",
            "messenger_outbox_publish_total{result=\"failure\"} 0.0",
        )
        for (outcome in listOf("empty", "work", "failed")) {
            assertScraped("messenger_outbox_batch_seconds_count{outcome=\"$outcome\"} 0")
        }
        for (reason in listOf("complete_failure", "interrupted", "deadline", "publish_failure")) {
            assertScraped("messenger_outbox_retained_total{reason=\"$reason\"} 0.0")
        }
        for (outcome in listOf("success", "failure")) {
            assertScraped("messenger_outbox_publication_seconds_count{outcome=\"$outcome\"} 0")
        }
        for (phase in listOf("claim", "hydrate", "publish", "complete")) {
            val outcomes = if (phase == "publish") listOf("success", "failure", "deadline", "cancelled") else listOf("success", "failure")
            for (outcome in outcomes) {
                assertScraped("messenger_outbox_stage_seconds_count{outcome=\"$outcome\",phase=\"$phase\"} 0")
            }
        }
        for (room in listOf("group", "user")) {
            assertScraped("messenger_outbox_publication_age_seconds_count{room_kind=\"$room\"} 0")
            for (reason in listOf("missing", "future")) {
                assertScraped("messenger_outbox_publication_age_invalid_total{reason=\"$reason\",room_kind=\"$room\"} 0.0")
            }
        }
        assertTrue(registry.meters.all { !it.id.description.isNullOrBlank() })
    }

    @Test
    fun `backlog ages between samples and failures retain the last known backlog`() {
        metrics.backlogSampled(7, now.minusSeconds(90).atOffset(ZoneOffset.UTC))
        assertScraped(
            "messenger_outbox_pending 7.0",
            "messenger_outbox_oldest_age_seconds 90.0",
            "messenger_outbox_backlog_sample_healthy 1.0",
        )
        `when`(clock.instant()).thenReturn(now.plusSeconds(5))
        metrics.backlogSampleFailed()
        assertScraped(
            "messenger_outbox_pending 7.0",
            "messenger_outbox_oldest_age_seconds 95.0",
            "messenger_outbox_backlog_sample_healthy 0.0",
            "messenger_outbox_backlog_sample_failures_total 1.0",
        )
        metrics.backlogSampled(1, now.plusSeconds(20).atOffset(ZoneOffset.UTC))
        assertScraped("messenger_outbox_oldest_age_seconds 0.0")
        metrics.backlogSampled(0, null)
        assertScraped(
            "messenger_outbox_pending 0.0",
            "messenger_outbox_oldest_age_seconds 0.0",
            "messenger_outbox_backlog_sample_healthy 1.0",
        )
    }

    @Test
    fun `publication records counts retention batches and stage outcomes`() {
        metrics.claimed(5)
        metrics.published()
        metrics.publicationFinished(metrics.started(), OutboxPublicationOutcome.SUCCESS)
        metrics.publishFailed()
        metrics.publicationFinished(metrics.started(), OutboxPublicationOutcome.FAILURE)
        for (reason in OutboxRetentionReason.entries) metrics.retained(reason, 3)
        for (outcome in OutboxBatchOutcome.entries) metrics.batchFinished(metrics.started(), outcome)
        for (stage in OutboxStage.entries) {
            val outcomes = when (stage) {
                OutboxStage.PUBLISH -> OutboxStageOutcome.entries
                else -> listOf(OutboxStageOutcome.SUCCESS, OutboxStageOutcome.FAILURE)
            }
            for (outcome in outcomes) metrics.stageFinished(metrics.started(), stage, outcome)
        }
        assertScraped(
            "messenger_outbox_claimed_total 5.0",
            "messenger_outbox_publish_total{result=\"success\"} 1.0",
            "messenger_outbox_publish_total{result=\"failure\"} 1.0",
            "messenger_outbox_publication_seconds_count{outcome=\"success\"} 1",
            "messenger_outbox_publication_seconds_count{outcome=\"failure\"} 1",
            "messenger_outbox_stage_seconds_count{outcome=\"deadline\",phase=\"publish\"} 1",
            "messenger_outbox_stage_seconds_count{outcome=\"cancelled\",phase=\"publish\"} 1",
        )
        for (outcome in listOf("empty", "work", "failed")) {
            assertScraped("messenger_outbox_batch_seconds_count{outcome=\"$outcome\"} 1")
        }
        for (reason in listOf("complete_failure", "interrupted", "deadline", "publish_failure")) {
            assertScraped("messenger_outbox_retained_total{reason=\"$reason\"} 3.0")
        }
        val histogram = registry.get("messenger.outbox.publication").tag("outcome", "success").timer().takeSnapshot().histogramCounts()
        assertEquals(1.0, histogram.first().bucket(TimeUnit.MILLISECONDS))
        assertEquals(120000.0, histogram.last().bucket(TimeUnit.MILLISECONDS))
        assertEquals(
            histogram.map { it.bucket() },
            registry.get("messenger.outbox.stage").tags("phase", "claim", "outcome", "success")
                .timer().takeSnapshot().histogramCounts().map { it.bucket() },
        )
    }

    @Test
    fun `publication age preserves exact SLO buckets and invalid timestamp labels`() {
        val timestamp = OffsetDateTime.ofInstant(now, ZoneOffset.UTC)
        for (room in listOf("group:test", "user:test")) {
            metrics.publicationAttempted(outboxEvent(room).copy(createdAt = timestamp.minusNanos(125_000_000)), timestamp)
            metrics.publicationAttempted(outboxEvent(room), timestamp)
            metrics.publicationAttempted(outboxEvent(room).copy(createdAt = timestamp.plusNanos(1)), timestamp)
            val kind = room.substringBefore(':')
            assertScraped(
                "messenger_outbox_publication_age_seconds_count{room_kind=\"$kind\"} 1",
                "messenger_outbox_publication_age_seconds_sum{room_kind=\"$kind\"} 0.125",
                "messenger_outbox_publication_age_seconds_bucket{room_kind=\"$kind\",le=\"0.1\"} 0",
                "messenger_outbox_publication_age_seconds_bucket{room_kind=\"$kind\",le=\"0.25\"} 1",
                "messenger_outbox_publication_age_seconds_bucket{room_kind=\"$kind\",le=\"+Inf\"} 1",
                "messenger_outbox_publication_age_invalid_total{reason=\"missing\",room_kind=\"$kind\"} 1.0",
                "messenger_outbox_publication_age_invalid_total{reason=\"future\",room_kind=\"$kind\"} 1.0",
            )
            assertEquals(
                listOf(1.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0),
                registry.get("messenger.outbox.publication.age").tag("room_kind", kind)
                    .timer().takeSnapshot().histogramCounts().map { it.bucket(TimeUnit.MILLISECONDS) },
            )
        }
    }

    private fun assertScraped(vararg samples: String) {
        val lines = registry.scrape().lineSequence().toSet()
        samples.forEach { sample -> assertTrue(sample in lines, "missing $sample") }
    }
}
