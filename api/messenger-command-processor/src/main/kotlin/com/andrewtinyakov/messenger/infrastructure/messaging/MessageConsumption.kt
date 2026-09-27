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
    kind: String,
    action: () -> Unit,
) {
    val tag = message.messageProperties.deliveryTag
    val sample = Timer.start(metrics)
    try {
        action()
    } catch (error: Exception) {
        val permanent = error is IllegalArgumentException || error is JacksonException
        metrics.counter("messenger.command.consumed", "kind", kind, "outcome", if (permanent) "permanent_failure" else "retry").increment()
        logger.error(
            "Message handling failed: routingKey={}, permanent={}",
            message.messageProperties.receivedRoutingKey,
            permanent,
            error,
        )
        channel.basicReject(tag, !permanent)
        sample.stop(metrics.timer("messenger.command.processing", "kind", kind, "outcome", "failed"))
        return
    }
    channel.basicAck(tag, false)
    metrics.counter("messenger.command.consumed", "kind", kind, "outcome", "acknowledged").increment()
    sample.stop(metrics.timer("messenger.command.processing", "kind", kind, "outcome", "acknowledged"))
}
