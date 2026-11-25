package com.andrewtinyakov.messenger.message.monitoring

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Duration
import java.util.concurrent.TimeUnit

@Component
class MessageMetrics(
    registry: MeterRegistry,
) {
    private val pageTimers = (HistoryDirection.entries.map { it.metricValue() } + listOf(AROUND, CHANGES)).flatMap { page ->
        listOf(SUCCESS, FAILED).map { outcome ->
            (page to outcome) to Timer.builder("messenger.history.page")
                .description("Duration of reading one history, around-anchor, or change page.")
                .tags("direction", page, "outcome", outcome)
                .publishPercentileHistogram()
                .minimumExpectedValue(Duration.ofMillis(1))
                .maximumExpectedValue(Duration.ofMinutes(2))
                .register(registry)
        }
    }.toMap()
    private val servedMessages = HistoryDirection.entries.associateWith { direction ->
        Counter.builder("messenger.history.messages")
            .description("Messages returned by history pages.")
            .tag("direction", direction.metricValue())
            .register(registry)
    }
    private val exhaustedSpanBudgets = HistoryDirection.entries.associateWith { direction ->
        Counter.builder("messenger.history.span.budget.exhausted")
            .description("History pages that stopped at the visible span budget before filling the limit.")
            .tag("direction", direction.metricValue())
            .register(registry)
    }
    private val changeResets = Counter.builder("messenger.message.changes.resets")
        .description("Change feed requests whose cursor fell outside retained changes.")
        .register(registry)
    private val prunedChanges = Counter.builder("messenger.message.changes.pruned")
        .description("Message change rows removed by retention.")
        .register(registry)
    private val edits = (listOf(SUCCESS) + MessageEditFailure.entries.map { it.metricValue }).associateWith { outcome ->
        Counter.builder("messenger.message.mutations")
            .description("Message edit attempts by outcome.")
            .tags("kind", "edit", "outcome", outcome)
            .register(registry)
    }

    fun <T> timeMessages(direction: HistoryDirection, read: () -> T): T = timePage(direction.metricValue(), read)

    fun <T> timeAround(read: () -> T): T = timePage(AROUND, read)

    fun <T> timeChanges(read: () -> T): T = timePage(CHANGES, read)

    fun messagesServed(direction: HistoryDirection, count: Int) = servedMessages.getValue(direction).increment(count.toDouble())

    fun spanBudgetExhausted(direction: HistoryDirection) = exhaustedSpanBudgets.getValue(direction).increment()

    fun changesReset() = changeResets.increment()

    fun changesPruned(count: Int) = prunedChanges.increment(count.toDouble())

    fun edited() = edits.getValue(SUCCESS).increment()

    fun editFailed(failure: MessageEditFailure) = edits.getValue(failure.metricValue).increment()

    private fun <T> timePage(page: String, read: () -> T): T {
        val started = System.nanoTime()
        var outcome = FAILED
        try {
            return read().also { outcome = SUCCESS }
        } finally {
            pageTimers.getValue(page to outcome).record(System.nanoTime() - started, TimeUnit.NANOSECONDS)
        }
    }

    private companion object {
        const val AROUND = "around"
        const val CHANGES = "changes"
        const val SUCCESS = "success"
        const val FAILED = "failed"

        fun HistoryDirection.metricValue(): String = name.lowercase()
    }
}
