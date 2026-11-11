package com.andrewtinyakov.messenger.message.messaging.listener

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.infrastructure.messaging.config.CommandTopology
import com.andrewtinyakov.messenger.infrastructure.messaging.listener.consumeMessage
import com.andrewtinyakov.messenger.infrastructure.messaging.model.CommandKind
import com.andrewtinyakov.messenger.infrastructure.messaging.monitoring.CommandMetrics
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
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
    private val service: MessageSendService,
    private val batches: MessageSendBatchService,
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
        val deliveries = messages.groupBy { it.messageProperties.deliveryTag }
        val accepted = mutableListOf<PendingSend>()
        for (fragments in deliveries.values) {
            val message = fragments.first()
            val started = metrics.commandProcessingStarted()
            val decoded = runCatching {
                require(fragments.size == 1) { "Producer command batches are unsupported" }
                require(message.body.size <= MAX_COMMAND_BYTES) { "Command exceeds wire byte limit" }
                val command: SendMessageCommandV1 = reader.readValue(message.body)
                SendStageRecorder.commit(received[message.messageProperties.deliveryTag], command.requestId)
                val target = SendTarget.from(command.toSendRequest())
                metrics.commandDequeued(
                    Duration.between(command.sentAt, OffsetDateTime.now()),
                )
                PendingSend(message, command, target, started)
            }
            val pending = decoded.getOrElse { error ->
                consumeMessage(message, channel, logger, metrics, CommandKind.SEND, started) { throw error }
                null
            }
            if (pending != null) accepted.add(pending)
        }
        for (group in accepted.groupBy { it.target }.values) {
            for (chunk in group.chunked(MessageSendBatchService.MAX_BATCH_SIZE)) {
                val processed = try {
                    Result.success(batches.process(chunk.map { it.command }))
                } catch (error: Exception) {
                    Result.failure(error)
                }
                val results = processed.getOrNull()
                if (results != null) {
                    chunk.zip(results).forEach { (pending, _) ->
                        consumeMessage(pending.message, channel, logger, metrics, CommandKind.SEND, pending.started) {}
                    }
                } else {
                    logger.warn("Send batch failed; resolving {} commands individually", chunk.size, processed.exceptionOrNull())
                    for (pending in chunk) {
                        consumeMessage(pending.message, channel, logger, metrics, CommandKind.SEND, pending.started) {
                            if (chunk.size == 1) {
                                throw processed.exceptionOrNull()!!
                            } else {
                                batches.process(listOf(pending.command)).single()
                            }
                        }
                    }
                }
            }
        }
    }

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
        service.rejectExhausted(command)
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
