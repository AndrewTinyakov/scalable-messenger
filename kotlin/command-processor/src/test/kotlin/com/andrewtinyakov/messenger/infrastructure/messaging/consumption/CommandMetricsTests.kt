package com.andrewtinyakov.messenger.infrastructure.messaging.consumption

import io.micrometer.core.instrument.Meter
import io.micrometer.core.instrument.config.MeterFilter
import io.micrometer.core.instrument.distribution.DistributionStatisticConfig
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Duration

class CommandMetricsTests {
    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT).apply {
        config().meterFilter(object : MeterFilter {
            override fun configure(id: Meter.Id, config: DistributionStatisticConfig): DistributionStatisticConfig =
                DistributionStatisticConfig.builder().percentilesHistogram(true).build().merge(config)
        })
    }
    private val metrics = CommandMetrics(registry)

    @Test
    fun `every command label combination is exposed before the first delivery`() {
        assertScraped("messenger_command_queue_delay_seconds_count 0")
        for (kind in listOf("send", "dead_letter")) {
            for (outcome in listOf("permanent_failure", "retry", "acknowledged")) {
                assertScraped("messenger_command_consumed_total{kind=\"$kind\",outcome=\"$outcome\"} 0.0")
            }
            for (outcome in listOf("failed", "acknowledged")) {
                assertScraped("messenger_command_processing_seconds_count{kind=\"$kind\",outcome=\"$outcome\"} 0")
            }
            for (operation in listOf("ack", "reject")) {
                for (result in listOf("success", "failure")) {
                    assertScraped(
                        "messenger_command_acknowledgement_total{kind=\"$kind\",operation=\"$operation\",result=\"$result\"} 0.0",
                    )
                }
            }
        }
    }

    @Test
    fun `dequeued commands retain seconds and the configured histogram boundaries`() {
        metrics.commandDequeued(Duration.ofMillis(250))
        metrics.commandDequeued(Duration.ofSeconds(-1))

        assertScraped(
            "messenger_command_queue_delay_seconds_count 2",
            "messenger_command_queue_delay_seconds_sum 0.25",
            "messenger_command_queue_delay_seconds_bucket{le=\"0.001\"} 1",
            "messenger_command_queue_delay_seconds_bucket{le=\"30.0\"} 2",
            "messenger_command_queue_delay_seconds_bucket{le=\"+Inf\"} 2",
        )
    }

    @Test
    fun `command events record their typed kind and outcomes`() {
        metrics.commandConsumed(CommandKind.SEND, CommandConsumptionOutcome.ACKNOWLEDGED)
        metrics.commandConsumed(CommandKind.SEND, CommandConsumptionOutcome.RETRY)
        metrics.commandConsumed(CommandKind.DEAD_LETTER, CommandConsumptionOutcome.PERMANENT_FAILURE)
        metrics.commandAcknowledgementCompleted(CommandKind.SEND, CommandAcknowledgementOperation.ACK, CommandAcknowledgementResult.SUCCESS)
        metrics.commandAcknowledgementCompleted(CommandKind.SEND, CommandAcknowledgementOperation.ACK, CommandAcknowledgementResult.FAILURE)
        metrics.commandAcknowledgementCompleted(
            CommandKind.DEAD_LETTER,
            CommandAcknowledgementOperation.REJECT,
            CommandAcknowledgementResult.SUCCESS,
        )
        metrics.commandAcknowledgementCompleted(
            CommandKind.SEND,
            CommandAcknowledgementOperation.REJECT,
            CommandAcknowledgementResult.FAILURE,
        )
        metrics.commandProcessingCompleted(CommandKind.SEND, CommandProcessingOutcome.ACKNOWLEDGED, metrics.commandProcessingStarted())
        metrics.commandProcessingCompleted(CommandKind.DEAD_LETTER, CommandProcessingOutcome.FAILED, metrics.commandProcessingStarted())

        assertScraped(
            "messenger_command_consumed_total{kind=\"send\",outcome=\"acknowledged\"} 1.0",
            "messenger_command_consumed_total{kind=\"send\",outcome=\"retry\"} 1.0",
            "messenger_command_consumed_total{kind=\"dead_letter\",outcome=\"permanent_failure\"} 1.0",
            "messenger_command_acknowledgement_total{kind=\"send\",operation=\"ack\",result=\"success\"} 1.0",
            "messenger_command_acknowledgement_total{kind=\"send\",operation=\"ack\",result=\"failure\"} 1.0",
            "messenger_command_acknowledgement_total{kind=\"dead_letter\",operation=\"reject\",result=\"success\"} 1.0",
            "messenger_command_acknowledgement_total{kind=\"send\",operation=\"reject\",result=\"failure\"} 1.0",
            "messenger_command_processing_seconds_count{kind=\"send\",outcome=\"acknowledged\"} 1",
            "messenger_command_processing_seconds_count{kind=\"dead_letter\",outcome=\"failed\"} 1",
            "messenger_command_processing_seconds_bucket{kind=\"send\",outcome=\"failed\",le=\"0.001\"} 0",
            "messenger_command_processing_seconds_bucket{kind=\"send\",outcome=\"failed\",le=\"30.0\"} 0",
        )
    }

    private fun assertScraped(vararg samples: String) {
        val scrape = registry.scrape().lineSequence().toSet()
        samples.forEach { sample -> assertTrue(sample in scrape, "missing $sample") }
    }
}
