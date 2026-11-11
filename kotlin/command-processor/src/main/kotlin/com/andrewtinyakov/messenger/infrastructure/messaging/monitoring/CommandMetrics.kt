package com.andrewtinyakov.messenger.infrastructure.messaging.monitoring

import com.andrewtinyakov.messenger.infrastructure.messaging.CommandAcknowledgementOperation
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandAcknowledgementResult
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandConsumptionOutcome
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandKind
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandProcessingOutcome
import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Duration
import java.util.concurrent.TimeUnit

@Component
class CommandMetrics(
    registry: MeterRegistry,
) {
    private val queueDelay = Timer.builder("messenger.command.queue.delay")
        .description("Time from command publication to decoding by the send listener.")
        .register(registry)
    private val consumed = CommandKind.entries.associateWith { kind ->
        CommandConsumptionOutcome.entries.associateWith { outcome ->
            Counter.builder("messenger.command.consumed")
                .description("Command deliveries by processing and acknowledgement outcome.")
                .tags("kind", kind.metricValue, "outcome", outcome.metricValue)
                .register(registry)
        }
    }
    private val processing = CommandKind.entries.associateWith { kind ->
        CommandProcessingOutcome.entries.associateWith { outcome ->
            Timer.builder("messenger.command.processing")
                .description(
                    "Per-delivery decode start through broker acknowledgement attempt, including subsequent batch sequencing waits",
                )
                .tags("kind", kind.metricValue, "outcome", outcome.metricValue)
                .register(registry)
        }
    }
    private val acknowledgements = CommandKind.entries.associateWith { kind ->
        CommandAcknowledgementOperation.entries.associateWith { operation ->
            CommandAcknowledgementResult.entries.associateWith { result ->
                Counter.builder("messenger.command.acknowledgement")
                    .description("Broker acknowledgement and rejection attempts by result.")
                    .tags("kind", kind.metricValue, "operation", operation.metricValue, "result", result.metricValue)
                    .register(registry)
            }
        }
    }

    fun commandDequeued(queuedFor: Duration) = queueDelay.record(queuedFor.coerceAtLeast(Duration.ZERO))

    fun commandProcessingStarted(): Long = System.nanoTime()

    internal fun commandConsumed(kind: CommandKind, outcome: CommandConsumptionOutcome) =
        consumed.getValue(kind).getValue(outcome).increment()

    internal fun commandProcessingCompleted(kind: CommandKind, outcome: CommandProcessingOutcome, started: Long) =
        processing.getValue(kind).getValue(outcome).record(System.nanoTime() - started, TimeUnit.NANOSECONDS)

    internal fun commandAcknowledgementCompleted(
        kind: CommandKind,
        operation: CommandAcknowledgementOperation,
        result: CommandAcknowledgementResult,
    ) = acknowledgements.getValue(kind).getValue(operation).getValue(result).increment()
}
