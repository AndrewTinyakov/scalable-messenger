package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.infrastructure.redis.monitoring.PublicationHydrationMetrics
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PublicationHydrationMetricsTests {
    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    private val metrics = PublicationHydrationMetrics(registry)

    @Test
    fun `all series are exposed before the first hydration`() {
        assertScraped(
            "messenger_outbox_hydration_total{result=\"saved\"} 0.0",
            "messenger_outbox_hydration_total{result=\"absent\"} 0.0",
            "messenger_outbox_hydration_batch_count 0",
            "messenger_outbox_hydration_batch_sum 0.0",
            "messenger_outbox_hydration_batch_max 0.0",
        )
        assertTrue(registry.meters.all { !it.id.description.isNullOrBlank() })
    }

    @Test
    fun `hydration counts recipient results separately from distinct requested messages`() {
        metrics.batchRequested(3)
        metrics.batchRequested(1)
        repeat(5) { metrics.saved() }
        metrics.absent()

        assertScraped(
            "messenger_outbox_hydration_total{result=\"saved\"} 5.0",
            "messenger_outbox_hydration_total{result=\"absent\"} 1.0",
            "messenger_outbox_hydration_batch_count 2",
            "messenger_outbox_hydration_batch_sum 4.0",
            "messenger_outbox_hydration_batch_max 3.0",
        )
    }

    private fun assertScraped(vararg samples: String) {
        val lines = registry.scrape().lineSequence().toSet()
        samples.forEach { sample -> assertTrue(sample in lines, "missing $sample") }
    }
}
