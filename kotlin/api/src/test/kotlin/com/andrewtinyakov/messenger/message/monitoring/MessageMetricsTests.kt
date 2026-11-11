package com.andrewtinyakov.messenger.message.monitoring

import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class MessageMetricsTests {
    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    private val metrics = MessageMetrics(registry)

    private fun assertScraped(vararg samples: String) {
        val scrape = registry.scrape()
        samples.forEach { sample -> assertTrue(scrape.contains(sample), "missing $sample") }
    }

    @Test
    fun `every series is exposed at zero before the first event`() {
        assertScraped(
            "messenger_history_page_seconds_count{direction=\"after\",outcome=\"success\"} 0",
            "messenger_history_page_seconds_count{direction=\"before\",outcome=\"failed\"} 0",
            "messenger_history_page_seconds_count{direction=\"around\",outcome=\"success\"} 0",
            "messenger_history_page_seconds_count{direction=\"changes\",outcome=\"failed\"} 0",
            "messenger_history_messages_total{direction=\"after\"} 0.0",
            "messenger_history_messages_total{direction=\"before\"} 0.0",
            "messenger_history_span_budget_exhausted_total{direction=\"after\"} 0.0",
            "messenger_history_span_budget_exhausted_total{direction=\"before\"} 0.0",
            "messenger_message_changes_resets_total 0.0",
            "messenger_message_changes_pruned_total 0.0",
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"success\"} 0.0",
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"forbidden\"} 0.0",
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"conflict\"} 0.0",
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"failed\"} 0.0",
        )
    }

    @Test
    fun `history pages are timed by direction and outcome`() {
        metrics.timeMessages(HistoryDirection.BEFORE) { metrics.messagesServed(HistoryDirection.BEFORE, 30) }
        metrics.timeAround { }
        assertThrows(IllegalStateException::class.java) { metrics.timeChanges { error("missing chat") } }
        metrics.spanBudgetExhausted(HistoryDirection.AFTER)
        metrics.changesReset()

        assertScraped(
            "messenger_history_page_seconds_count{direction=\"before\",outcome=\"success\"} 1",
            "messenger_history_page_seconds_count{direction=\"around\",outcome=\"success\"} 1",
            "messenger_history_page_seconds_count{direction=\"changes\",outcome=\"failed\"} 1",
            "messenger_history_messages_total{direction=\"before\"} 30.0",
            "messenger_history_span_budget_exhausted_total{direction=\"after\"} 1.0",
            "messenger_message_changes_resets_total 1.0",
        )
    }

    @Test
    fun `edits and change retention keep their existing labels`() {
        metrics.edited()
        metrics.editFailed(MessageEditFailure.FORBIDDEN)
        metrics.editFailed(MessageEditFailure.CONFLICT)
        metrics.editFailed(MessageEditFailure.ERROR)
        metrics.changesPruned(250)

        assertScraped(
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"success\"} 1.0",
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"forbidden\"} 1.0",
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"conflict\"} 1.0",
            "messenger_message_mutations_total{kind=\"edit\",outcome=\"failed\"} 1.0",
            "messenger_message_changes_pruned_total 250.0",
        )
    }
}
