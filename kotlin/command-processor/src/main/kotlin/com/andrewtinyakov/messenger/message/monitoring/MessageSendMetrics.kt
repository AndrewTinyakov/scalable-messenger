package com.andrewtinyakov.messenger.message.monitoring

import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.SendBatch
import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Duration

@Component
class MessageSendMetrics(
    registry: MeterRegistry,
) {
    private val transaction = histogram(registry, "messenger.send.transaction", "Send transaction duration per request.")
    private val hold = histogram(registry, "messenger.send.transaction.hold", "Time from chat lock acquisition to transaction completion.")
    private val completion = histogram(
        registry,
        "messenger.send.transaction.completion",
        "Time from transaction callback return to transaction completion per request.",
    )
    private val chatLock = histogram(registry, "messenger.send.chat.lock.acquire", "Time spent acquiring a chat lock.")
    private val commandResults = CommandResult.entries.associateWith { result ->
        Counter.builder("messenger.command.result")
            .description("Committed send command results.")
            .tag("result", result.metricValue)
            .register(registry)
    }
    private val batches = BatchOutcome.entries.associateWith { outcome ->
        BatchMeters(
            transaction = Timer.builder("messenger.send.batch.transaction")
                .description("Send batch transaction duration by completion outcome.")
                .tag("outcome", outcome.metricValue)
                .publishPercentileHistogram()
                .register(registry),
            completion = Timer.builder("messenger.send.batch.completion")
                .description("Time from send batch callback return to transaction completion.")
                .tag("outcome", outcome.metricValue)
                .publishPercentileHistogram()
                .register(registry),
            size = DistributionSummary.builder("messenger.send.batch.size")
                .description("Number of commands in each send batch by transaction completion outcome.")
                .tag("outcome", outcome.metricValue)
                .publishPercentileHistogram()
                .maximumExpectedValue(SendBatch.MAX_SIZE.toDouble())
                .register(registry),
        )
    }

    fun commandCompleted(result: CommandResult) = commandResults.getValue(result).increment()

    fun batchCompleted(size: Int, outcome: BatchOutcome, transactionDuration: Duration, completionDuration: Duration) {
        val meters = batches.getValue(outcome)
        meters.transaction.record(transactionDuration)
        meters.completion.record(completionDuration)
        meters.size.record(size.toDouble())
    }

    fun <T> timeChatLock(acquire: () -> T): T {
        val started = System.nanoTime()
        try {
            return acquire()
        } finally {
            chatLock.record(Duration.ofNanos(System.nanoTime() - started))
        }
    }

    internal fun transactionStarted(requests: Int = 1) = TransactionWindow(requests)

    internal inner class TransactionWindow(
        private val requests: Int,
    ) {
        private val started = System.nanoTime()
        private var state: TransactionWindowState = TransactionWindowState.Executing()

        fun chatLocked() {
            if (state is TransactionWindowState.Executing) {
                state = TransactionWindowState.Executing(System.nanoTime())
            }
        }

        fun callbackFinished() {
            state = when (val current = state) {
                is TransactionWindowState.Executing -> TransactionWindowState.CallbackFinished(current.locked, System.nanoTime())
                is TransactionWindowState.CallbackFinished -> current.copy(finished = System.nanoTime())
                TransactionWindowState.Observed -> return
            }
        }

        fun completed() {
            val current = state
            if (current == TransactionWindowState.Observed) return
            state = TransactionWindowState.Observed
            val locked = when (current) {
                is TransactionWindowState.Executing -> current.locked
                is TransactionWindowState.CallbackFinished -> current.locked
                TransactionWindowState.Observed -> return
            }
            val callbackFinished = (current as? TransactionWindowState.CallbackFinished)?.finished
            val finished = System.nanoTime()
            repeat(requests) {
                transaction.record(Duration.ofNanos(finished - started))
                locked?.let { hold.record(Duration.ofNanos(finished - it)) }
                callbackFinished?.let { completion.record(Duration.ofNanos(finished - it)) }
            }
        }
    }

    private sealed interface TransactionWindowState {
        data class Executing(
            val locked: Long? = null,
        ) : TransactionWindowState

        data class CallbackFinished(
            val locked: Long?,
            val finished: Long,
        ) : TransactionWindowState

        data object Observed : TransactionWindowState
    }

    private fun histogram(registry: MeterRegistry, name: String, description: String): Timer =
        Timer.builder(name)
            .description(description)
            .publishPercentileHistogram()
            .minimumExpectedValue(Duration.ofMillis(1))
            .maximumExpectedValue(Duration.ofMinutes(2))
            .register(registry)

    enum class BatchOutcome {
        COMMITTED,
        ROLLED_BACK,
        UNKNOWN,
        ;

        val metricValue: String get() = name.lowercase()
    }

    private data class BatchMeters(
        val transaction: Timer,
        val completion: Timer,
        val size: DistributionSummary,
    )
}
