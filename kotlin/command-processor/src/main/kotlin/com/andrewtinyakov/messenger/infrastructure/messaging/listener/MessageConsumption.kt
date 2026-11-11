package com.andrewtinyakov.messenger.infrastructure.messaging.listener

import com.andrewtinyakov.messenger.infrastructure.messaging.model.CommandAcknowledgementOperation
import com.andrewtinyakov.messenger.infrastructure.messaging.model.CommandAcknowledgementResult
import com.andrewtinyakov.messenger.infrastructure.messaging.model.CommandConsumptionOutcome
import com.andrewtinyakov.messenger.infrastructure.messaging.model.CommandKind
import com.andrewtinyakov.messenger.infrastructure.messaging.model.CommandProcessingOutcome
import com.andrewtinyakov.messenger.infrastructure.messaging.monitoring.CommandMetrics
import com.rabbitmq.client.Channel
import org.slf4j.Logger
import org.springframework.amqp.core.Message
import tools.jackson.core.JacksonException

internal fun consumeMessage(
    message: Message,
    channel: Channel,
    logger: Logger,
    metrics: CommandMetrics,
    kind: CommandKind,
    started: Long = metrics.commandProcessingStarted(),
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
            metrics.commandConsumed(kind, outcome)
            logger.error(
                "Message handling failed: routingKey={}, permanent={}",
                message.messageProperties.receivedRoutingKey,
                permanent,
                error,
            )
            recordAcknowledgement(metrics, kind, CommandAcknowledgementOperation.REJECT) { channel.basicReject(tag, !permanent) }
            return
        }
        recordAcknowledgement(metrics, kind, CommandAcknowledgementOperation.ACK) { channel.basicAck(tag, false) }
        metrics.commandConsumed(kind, CommandConsumptionOutcome.ACKNOWLEDGED)
        processingOutcome = CommandProcessingOutcome.ACKNOWLEDGED
    } finally {
        metrics.commandProcessingCompleted(kind, processingOutcome, started)
    }
}

private inline fun recordAcknowledgement(
    metrics: CommandMetrics,
    kind: CommandKind,
    operation: CommandAcknowledgementOperation,
    action: () -> Unit,
) {
    var result = CommandAcknowledgementResult.FAILURE
    try {
        action()
        result = CommandAcknowledgementResult.SUCCESS
    } finally {
        metrics.commandAcknowledgementCompleted(kind, operation, result)
    }
}
