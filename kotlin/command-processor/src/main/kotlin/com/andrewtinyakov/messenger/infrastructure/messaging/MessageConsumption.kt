package com.andrewtinyakov.messenger.infrastructure.messaging

import com.rabbitmq.client.Channel
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.slf4j.Logger
import org.springframework.amqp.core.Message
import tools.jackson.core.JacksonException

internal fun consumeMessage(
    message: Message,
    channel: Channel,
    logger: Logger,
    metrics: MeterRegistry,
    kind: CommandKind,
    sample: Timer.Sample = Timer.start(metrics),
    action: () -> Unit,
) {
    val tag = message.messageProperties.deliveryTag
    var processingOutcome = CommandProcessingOutcome.FAILED
    try {
        try {
            action()
        } catch (error: Exception) {
            val permanent = error is IllegalArgumentException || error is JacksonException
            val outcome = if (permanent) CommandConsumptionOutcome.PERMANENT_FAILURE else CommandConsumptionOutcome.RETRY
            metrics.counter(
                "messenger.command.consumed",
                "kind",
                kind.metricValue,
                "outcome",
                outcome.metricValue,
            ).increment()
            logger.error(
                "Message handling failed: routingKey={}, permanent={}",
                message.messageProperties.receivedRoutingKey,
                permanent,
                error,
            )
            recordAcknowledgement(metrics, kind, "reject") { channel.basicReject(tag, !permanent) }
            return
        }
        recordAcknowledgement(metrics, kind, "ack") { channel.basicAck(tag, false) }
        metrics.counter(
            "messenger.command.consumed",
            "kind",
            kind.metricValue,
            "outcome",
            CommandConsumptionOutcome.ACKNOWLEDGED.metricValue,
        ).increment()
        processingOutcome = CommandProcessingOutcome.ACKNOWLEDGED
    } finally {
        sample.stop(
            Timer.builder("messenger.command.processing")
                .description(
                    "Per-delivery decode start through broker acknowledgement attempt, including subsequent batch sequencing waits",
                )
                .tags("kind", kind.metricValue, "outcome", processingOutcome.metricValue)
                .register(metrics),
        )
    }
}

private inline fun recordAcknowledgement(metrics: MeterRegistry, kind: CommandKind, operation: String, action: () -> Unit) {
    var result = "failure"
    try {
        action()
        result = "success"
    } finally {
        metrics.counter(
            "messenger.command.acknowledgement",
            "kind",
            kind.metricValue,
            "operation",
            operation,
            "result",
            result,
        ).increment()
    }
}
