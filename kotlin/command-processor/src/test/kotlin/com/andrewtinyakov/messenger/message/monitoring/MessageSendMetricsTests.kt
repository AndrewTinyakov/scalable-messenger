package com.andrewtinyakov.messenger.message.monitoring

import com.andrewtinyakov.messenger.message.model.CommandResult
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Duration

class MessageSendMetricsTests {
    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    private val metrics = MessageSendMetrics(registry)

    @Test
    fun `all send series and batch outcomes are exposed before work begins`() {
        for (result in listOf("saved", "rejected", "conflict", "duplicate")) {
            assertScraped("messenger_command_result_total{result=\"$result\"} 0.0")
        }
        for (timer in listOf("transaction", "transaction_hold", "transaction_completion", "chat_lock_acquire")) {
            assertScraped(
                "messenger_send_${timer}_seconds_count 0",
                "messenger_send_${timer}_seconds_bucket{le=\"0.001\"} 0",
                "messenger_send_${timer}_seconds_bucket{le=\"120.0\"} 0",
            )
        }
        for (outcome in listOf("committed", "rolled_back", "unknown")) {
            assertScraped(
                "messenger_send_batch_transaction_seconds_count{outcome=\"$outcome\"} 0",
                "messenger_send_batch_completion_seconds_count{outcome=\"$outcome\"} 0",
                "messenger_send_batch_size_count{outcome=\"$outcome\"} 0",
                "messenger_send_batch_transaction_seconds_bucket{outcome=\"$outcome\",le=\"0.001\"} 0",
                "messenger_send_batch_transaction_seconds_bucket{outcome=\"$outcome\",le=\"30.0\"} 0",
                "messenger_send_batch_size_bucket{outcome=\"$outcome\",le=\"16.0\"} 0",
            )
        }
    }

    @Test
    fun `command results keep their existing labels`() {
        metrics.commandCompleted(CommandResult.SAVED)
        metrics.commandCompleted(CommandResult.SAVED)
        metrics.commandCompleted(CommandResult.REJECTED)
        metrics.commandCompleted(CommandResult.CONFLICT)
        metrics.commandCompleted(CommandResult.DUPLICATE)

        assertScraped(
            "messenger_command_result_total{result=\"saved\"} 2.0",
            "messenger_command_result_total{result=\"rejected\"} 1.0",
            "messenger_command_result_total{result=\"conflict\"} 1.0",
            "messenger_command_result_total{result=\"duplicate\"} 1.0",
        )
    }

    @Test
    fun `completed batches record duration size and completion outcome`() {
        metrics.batchCompleted(3, SendBatchOutcome.COMMITTED, Duration.ofMillis(250), Duration.ofMillis(50))
        metrics.batchCompleted(2, SendBatchOutcome.ROLLED_BACK, Duration.ofMillis(500), Duration.ofMillis(100))
        metrics.batchCompleted(1, SendBatchOutcome.UNKNOWN, Duration.ofSeconds(1), Duration.ofMillis(200))

        assertScraped(
            "messenger_send_batch_transaction_seconds_count{outcome=\"committed\"} 1",
            "messenger_send_batch_transaction_seconds_sum{outcome=\"committed\"} 0.25",
            "messenger_send_batch_completion_seconds_sum{outcome=\"committed\"} 0.05",
            "messenger_send_batch_size_count{outcome=\"committed\"} 1",
            "messenger_send_batch_size_sum{outcome=\"committed\"} 3.0",
            "messenger_send_batch_size_bucket{outcome=\"committed\",le=\"16.0\"} 1",
            "messenger_send_batch_transaction_seconds_sum{outcome=\"rolled_back\"} 0.5",
            "messenger_send_batch_completion_seconds_sum{outcome=\"rolled_back\"} 0.1",
            "messenger_send_batch_size_sum{outcome=\"rolled_back\"} 2.0",
            "messenger_send_batch_transaction_seconds_sum{outcome=\"unknown\"} 1.0",
            "messenger_send_batch_completion_seconds_sum{outcome=\"unknown\"} 0.2",
            "messenger_send_batch_size_sum{outcome=\"unknown\"} 1.0",
        )
    }

    @Test
    fun `transaction windows count requests once and omit phases that did not happen`() {
        val batch = metrics.transactionStarted(3)
        batch.chatLocked()
        batch.callbackFinished()
        batch.completed()
        batch.completed()
        metrics.transactionStarted().completed()

        assertScraped(
            "messenger_send_transaction_seconds_count 4",
            "messenger_send_transaction_hold_seconds_count 3",
            "messenger_send_transaction_completion_seconds_count 3",
        )
    }

    @Test
    fun `chat lock acquisition is timed on success and failure`() {
        assertEquals("locked", metrics.timeChatLock { "locked" })
        assertThrows(IllegalStateException::class.java) {
            metrics.timeChatLock { throw IllegalStateException("lock failed") }
        }

        assertScraped("messenger_send_chat_lock_acquire_seconds_count 2")
    }

    private fun assertScraped(vararg samples: String) {
        val scrape = registry.scrape().lineSequence().toSet()
        samples.forEach { sample -> assertTrue(sample in scrape, "missing $sample") }
    }
}
