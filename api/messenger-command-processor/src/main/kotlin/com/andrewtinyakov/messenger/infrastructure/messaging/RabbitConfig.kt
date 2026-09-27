package com.andrewtinyakov.messenger.infrastructure.messaging

import org.springframework.amqp.core.Binding
import org.springframework.amqp.core.Declarable
import org.springframework.amqp.core.Declarables
import org.springframework.amqp.core.DirectExchange
import org.springframework.amqp.core.QueueBuilder
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(MessagingProperties::class)
class RabbitConfig {
    @Bean
    fun commandTopology(properties: MessagingProperties): Declarables {
        val declarations = buildList<Declarable> {
            add(DirectExchange(CommandTopology.EXCHANGE))
            add(DirectExchange(CommandTopology.DEAD_EXCHANGE))
            add(
                QueueBuilder.durable(CommandTopology.DEAD_QUEUE)
                    .quorum()
                    .withArgument("x-quorum-initial-group-size", 3)
                    .deliveryLimit(-1)
                    .withFailedDeliveryRetry()
                    .build(),
            )
            add(binding(CommandTopology.DEAD_QUEUE, CommandTopology.DEAD_EXCHANGE))
            for (queue in CommandTopology.queues) {
                add(
                    QueueBuilder.durable(queue)
                        .quorum()
                        .withArgument("x-quorum-initial-group-size", 3)
                        .withArgument("x-max-length", properties.maxQueueLength)
                        .overflow(QueueBuilder.Overflow.rejectPublish)
                        .deliveryLimit(properties.deliveryLimit)
                        .deadLetterExchange(CommandTopology.DEAD_EXCHANGE)
                        .deadLetterRoutingKey(CommandTopology.DEAD_QUEUE)
                        .withArgument("x-dead-letter-strategy", "at-least-once")
                        .withFailedDeliveryRetry()
                        .build(),
                )
                add(binding(queue, CommandTopology.EXCHANGE))
            }
        }
        return Declarables(declarations)
    }

    private fun binding(queue: String, exchange: String) = Binding(
        queue,
        Binding.DestinationType.QUEUE,
        exchange,
        queue,
        emptyMap(),
    )
}

private fun QueueBuilder.withFailedDeliveryRetry(): QueueBuilder =
    withArgument("x-delayed-retry-type", "failed")
        .withArgument("x-delayed-retry-min", 1000)
        .withArgument("x-delayed-retry-max", 30000)
