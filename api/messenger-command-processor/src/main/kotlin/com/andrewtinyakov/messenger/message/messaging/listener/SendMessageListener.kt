package com.andrewtinyakov.messenger.message.messaging.listener

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.infrastructure.messaging.CommandTopology
import com.andrewtinyakov.messenger.infrastructure.messaging.consumeMessage
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.rabbitmq.client.Channel
import io.micrometer.core.instrument.MeterRegistry
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
    private val metrics: MeterRegistry,
    mapper: ObjectMapper,
) {
    private val reader = mapper.readerFor(SendMessageCommandV1::class.java)
    private val logger = LoggerFactory.getLogger(javaClass)

    @RabbitListener(queues = ["messenger.send.0", "messenger.send.1", "messenger.send.2", "messenger.send.3"])
    fun onSendCommand(message: Message, channel: Channel) = consumeMessage(message, channel, logger, metrics, "send") {
        val command: SendMessageCommandV1 = reader.readValue(message.body)
        metrics.timer("messenger.command.queue.delay").record(
            Duration.between(command.sentAt, OffsetDateTime.now()).coerceAtLeast(Duration.ZERO),
        )
        val result = service.process(command)
        metrics.counter("messenger.command.result", "result", result).increment()
    }

    @RabbitListener(queues = [CommandTopology.DEAD_QUEUE])
    fun onExhaustedCommand(message: Message, channel: Channel) = consumeMessage(message, channel, logger, metrics, "dead_letter") {
        val deaths = message.messageProperties.headers["x-death"] as? List<*>
        require(deaths?.any { (it as? Map<*, *>)?.get("reason")?.toString() == "delivery_limit" } == true) {
            "Command did not exhaust its delivery limit"
        }
        val command: SendMessageCommandV1 = reader.readValue(message.body)
        service.rejectExhausted(command)
    }
}
