package com.andrewtinyakov.messenger.infrastructure.messaging.rabbit

import org.springframework.amqp.core.AcknowledgeMode
import org.springframework.amqp.core.Binding
import org.springframework.amqp.core.Declarable
import org.springframework.amqp.core.Declarables
import org.springframework.amqp.core.DirectExchange
import org.springframework.amqp.core.QueueBuilder
import org.springframework.amqp.rabbit.config.SimpleRabbitListenerContainerFactory
import org.springframework.amqp.rabbit.connection.ConnectionFactory
import org.springframework.boot.amqp.autoconfigure.SimpleRabbitListenerContainerFactoryConfigurer
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RabbitProperties::class)
class RabbitConfig {
    @Bean
    fun sendBatchListenerContainerFactory(
        configurer: SimpleRabbitListenerContainerFactoryConfigurer,
        connectionFactory: ConnectionFactory,
        properties: RabbitProperties,
    ): SimpleRabbitListenerContainerFactory = SimpleRabbitListenerContainerFactory().apply {
        configurer.configure(this, connectionFactory)
        setAcknowledgeMode(AcknowledgeMode.MANUAL)
        setConsumerBatchEnabled(true)
        setBatchSize(properties.sendBatchSize)
        setReceiveTimeout(properties.receiveTimeout.toMillis())
        setBatchReceiveTimeout(properties.batchReceiveTimeout.toMillis())
    }

    @Bean
    fun sendQueueNames(): List<String> = CommandTopology.queues

    @Bean
    fun commandTopology(properties: RabbitProperties): Declarables {
        val declarations = buildList<Declarable> {
            add(DirectExchange(CommandTopology.EXCHANGE))
            add(DirectExchange(CommandTopology.DEAD_EXCHANGE))
            add(
                QueueBuilder.durable(CommandTopology.DEAD_QUEUE)
                    .quorum()
                    .withArgument("x-quorum-initial-group-size", properties.quorumInitialGroupSize)
                    .deliveryLimit(-1)
                    .withFailedDeliveryRetry(properties)
                    .build(),
            )
            add(binding(CommandTopology.DEAD_QUEUE, CommandTopology.DEAD_EXCHANGE))
            for (queue in CommandTopology.queues) {
                add(
                    QueueBuilder.durable(queue)
                        .quorum()
                        .withArgument("x-quorum-initial-group-size", properties.quorumInitialGroupSize)
                        .withArgument("x-max-length", properties.maxQueueLength)
                        .overflow(QueueBuilder.Overflow.rejectPublish)
                        .deliveryLimit(properties.deliveryLimit)
                        .deadLetterExchange(CommandTopology.DEAD_EXCHANGE)
                        .deadLetterRoutingKey(CommandTopology.DEAD_QUEUE)
                        .withArgument("x-dead-letter-strategy", "at-least-once")
                        .withFailedDeliveryRetry(properties)
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

private fun QueueBuilder.withFailedDeliveryRetry(properties: RabbitProperties): QueueBuilder =
    withArgument("x-delayed-retry-type", "failed")
        .withArgument("x-delayed-retry-min", properties.failedDeliveryRetryMinDelay.toMillis().toInt())
        .withArgument("x-delayed-retry-max", properties.failedDeliveryRetryMaxDelay.toMillis().toInt())
