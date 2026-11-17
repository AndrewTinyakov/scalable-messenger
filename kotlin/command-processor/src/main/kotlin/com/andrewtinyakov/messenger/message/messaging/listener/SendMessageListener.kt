package com.andrewtinyakov.messenger.message.messaging.listener

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandKind
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandMetrics
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandTopology
import com.andrewtinyakov.messenger.infrastructure.messaging.consumeMessage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageEvent
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.message.model.SendBatch
import com.andrewtinyakov.messenger.message.model.SendTarget
import com.andrewtinyakov.messenger.message.service.MessageSendBatchService
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.message.service.toSendRequest
import com.rabbitmq.client.Channel
import org.slf4j.LoggerFactory
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper
import java.time.Duration
import java.time.OffsetDateTime

@Component
class SendMessageListener(
    private val messageSendService: MessageSendService,
    private val sendBatchService: MessageSendBatchService,
    private val metrics: CommandMetrics,
    mapper: ObjectMapper,
) {
    private val reader = mapper.readerFor(SendMessageCommandV1::class.java)
    private val logger = LoggerFactory.getLogger(javaClass)

    @RabbitListener(
        queues = ["#{@sendQueueNames}"],
        containerFactory = "sendBatchListenerContainerFactory",
    )
    fun onSendCommand(messages: List<Message>, channel: Channel) {
        val received = SendStageRecorder.beginEach(SendStage.LISTENER_RECEIVED, messages) { it.messageProperties.deliveryTag }
        val sends = decodeDeliveries(messages, received, channel)
        sends.groupBy { it.target }.values
            .flatMap { it.chunked(SendBatch.MAX_SIZE) }
            .forEach { chunk -> processChunk(chunk, channel) }
    }

    private fun decodeDeliveries(
        messages: List<Message>,
        received: Map<Long, SendStageEvent?>,
        channel: Channel,
    ): List<PendingSend> = messages.groupBy { it.messageProperties.deliveryTag }.values.mapNotNull { fragments ->
        val started = metrics.commandProcessingStarted()
        runCatching { decodeDelivery(fragments, received, started) }.getOrElse { error ->
            settle(fragments.first(), started, channel) { throw error }
            null
        }
    }

    private fun decodeDelivery(fragments: List<Message>, received: Map<Long, SendStageEvent?>, started: Long): PendingSend {
        val message = fragments.first()
        require(fragments.size == 1) { "Producer command batches are unsupported" }
        require(message.body.size <= MAX_COMMAND_BYTES) { "Command exceeds wire byte limit" }
        val command: SendMessageCommandV1 = reader.readValue(message.body)
        SendStageRecorder.commit(received[message.messageProperties.deliveryTag], command.requestId)
        val target = SendTarget.from(command.toSendRequest())
        metrics.commandDequeued(Duration.between(command.sentAt, OffsetDateTime.now()))
        return PendingSend(message, command, target, started)
    }

    private fun processChunk(chunk: List<PendingSend>, channel: Channel) {
        try {
            sendBatchService.process(chunk.map { it.command })
        } catch (error: Exception) {
            processIndividually(chunk, error, channel)
            return
        }
        acknowledge(chunk, channel)
    }

    private fun processIndividually(chunk: List<PendingSend>, batchFailure: Exception, channel: Channel) {
        logger.warn("Send batch failed; resolving {} commands individually", chunk.size, batchFailure)
        if (chunk.size == 1) {
            settle(chunk.single(), channel) { throw batchFailure }
            return
        }
        chunk.forEach { pending -> settle(pending, channel) { sendBatchService.process(listOf(pending.command)).single() } }
    }

    private fun acknowledge(chunk: List<PendingSend>, channel: Channel) = chunk.forEach { pending -> settle(pending, channel) {} }

    private fun settle(pending: PendingSend, channel: Channel, action: () -> Unit) = settle(
        pending.message,
        pending.started,
        channel,
        action,
    )

    private fun settle(message: Message, started: Long, channel: Channel, action: () -> Unit) =
        consumeMessage(message, channel, logger, metrics, CommandKind.SEND, started, action)

    @RabbitListener(queues = [CommandTopology.DEAD_QUEUE])
    fun onExhaustedCommand(
        message: Message,
        channel: Channel,
    ) = consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.DEAD_LETTER) {
        val deaths = message.messageProperties.headers["x-death"] as? List<*>
        require(deaths?.any { (it as? Map<*, *>)?.get("reason")?.toString() == "delivery_limit" } == true) {
            "Command did not exhaust its delivery limit"
        }
        val command: SendMessageCommandV1 = reader.readValue(message.body)
        messageSendService.rejectExhausted(command)
    }

    private data class PendingSend(
        val message: Message,
        val command: SendMessageCommandV1,
        val target: SendTarget,
        val started: Long,
    )

    companion object {
        const val MAX_COMMAND_BYTES = 65536
    }
}
