package com.andrewtinyakov.messenger.messaging

import org.springframework.amqp.core.BindingBuilder
import org.springframework.amqp.core.Declarables
import org.springframework.amqp.core.DirectExchange
import org.springframework.amqp.core.Queue
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

object CommandTopology {
    const val EXCHANGE = "messenger.commands"
    const val DEAD_EXCHANGE = "messenger.commands.dead"
    const val DEAD_QUEUE = "messenger.send.dead"
    const val PARTITIONS = 4

    fun route(conversationId: String): String {
        var hash = 0x811c9dc5u
        for (byte in conversationId.toByteArray(Charsets.UTF_8)) {
            hash = (hash xor byte.toUByte().toUInt()) * 0x01000193u
        }
        return "messenger.send.${hash % PARTITIONS.toUInt()}"
    }
}

@Configuration
class CommandTopologyConfiguration {
    @Bean
    fun commandDeclarables(): Declarables {
        val exchange = DirectExchange(CommandTopology.EXCHANGE, true, false)
        val deadExchange = DirectExchange(CommandTopology.DEAD_EXCHANGE, true, false)
        val deadQueue = Queue(CommandTopology.DEAD_QUEUE, true, false, false, mapOf("x-queue-type" to "quorum"))
        val queues = (0 until CommandTopology.PARTITIONS).map { index ->
            Queue(
                "messenger.send.$index",
                true,
                false,
                false,
                mapOf(
                    "x-queue-type" to "quorum",
                    "x-max-length" to 10000,
                    "x-overflow" to "reject-publish",
                    "x-delivery-limit" to 20,
                    "x-dead-letter-exchange" to CommandTopology.DEAD_EXCHANGE,
                    "x-dead-letter-routing-key" to CommandTopology.DEAD_QUEUE,
                ),
            )
        }
        return Declarables(
            listOf(exchange, deadExchange, deadQueue, BindingBuilder.bind(deadQueue).to(deadExchange).with(CommandTopology.DEAD_QUEUE)) +
                queues + queues.map { BindingBuilder.bind(it).to(exchange).with(it.name) },
        )
    }
}
