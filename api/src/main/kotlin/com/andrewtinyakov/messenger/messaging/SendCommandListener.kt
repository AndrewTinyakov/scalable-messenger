package com.andrewtinyakov.messenger.messaging

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.shared.ApiException
import com.fasterxml.jackson.databind.ObjectMapper
import com.rabbitmq.client.Channel
import org.springframework.amqp.core.Message
import org.springframework.amqp.rabbit.annotation.RabbitListener
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component

@Component
@ConditionalOnProperty(name = ["messenger.role"], havingValue = "worker")
class SendCommandListener(
    private val mapper: ObjectMapper,
    private val service: SendCommandService,
) {
    @RabbitListener(queues = ["messenger.send.0", "messenger.send.1", "messenger.send.2", "messenger.send.3"])
    fun onSendCommand(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val command = try {
            mapper.readValue(message.body, SendMessageCommandV1::class.java)
        } catch (error: Exception) {
            org.slf4j.LoggerFactory.getLogger(javaClass).warn("Rejecting malformed command", error)
            channel.basicReject(tag, false)
            return
        }
        try {
            service.process(command)
            channel.basicAck(tag, false)
        } catch (error: IllegalArgumentException) {
            org.slf4j.LoggerFactory.getLogger(javaClass).warn("Rejecting invalid command {}", command.requestId, error)
            channel.basicReject(tag, false)
        } catch (error: ApiException) {
            org.slf4j.LoggerFactory.getLogger(javaClass).warn("Rejecting invalid command {}", command.requestId, error)
            channel.basicReject(tag, false)
        } catch (error: Exception) {
            org.slf4j.LoggerFactory.getLogger(javaClass).error("Retrying command {}", command.requestId, error)
            channel.basicNack(tag, false, true)
        }
    }

    @RabbitListener(queues = [CommandTopology.DEAD_QUEUE])
    fun onExhaustedCommand(message: Message, channel: Channel) {
        val tag = message.messageProperties.deliveryTag
        val command = try {
            mapper.readValue(message.body, SendMessageCommandV1::class.java)
        } catch (error: Exception) {
            org.slf4j.LoggerFactory.getLogger(javaClass).error("Malformed command in dead-letter queue", error)
            channel.basicAck(tag, false)
            return
        }
        try {
            service.rejectExhausted(command)
            channel.basicAck(tag, false)
        } catch (error: IllegalArgumentException) {
            org.slf4j.LoggerFactory.getLogger(javaClass).error("Invalid command in dead-letter queue {}", command.requestId, error)
            channel.basicAck(tag, false)
        } catch (error: ApiException) {
            org.slf4j.LoggerFactory.getLogger(javaClass).error("Invalid command in dead-letter queue {}", command.requestId, error)
            channel.basicAck(tag, false)
        } catch (error: Exception) {
            org.slf4j.LoggerFactory.getLogger(javaClass).error("Could not record terminal result for {}", command.requestId, error)
            channel.basicNack(tag, false, true)
        }
    }
}
