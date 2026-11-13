package com.andrewtinyakov.messenger.infrastructure.messaging.config

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.context.annotation.Configuration
import java.time.Duration

class MessagingPropertiesTests {
    private val runner = ApplicationContextRunner().withUserConfiguration(PropertiesConfiguration::class.java)

    @Test
    fun `messaging settings keep their defaults`() {
        runner.run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context.getBean(MessagingProperties::class.java)).isEqualTo(
                MessagingProperties(
                    deliveryLimit = 20,
                    maxQueueLength = 10000,
                    sendBatchSize = 16,
                    receiveTimeout = Duration.ofMillis(1),
                    batchReceiveTimeout = Duration.ofMillis(5),
                    quorumInitialGroupSize = 3,
                    failedDeliveryRetryMinDelay = Duration.ofSeconds(1),
                    failedDeliveryRetryMaxDelay = Duration.ofSeconds(30),
                ),
            )
        }
    }

    @Test
    fun `messaging settings bind to validated properties`() {
        runner.withPropertyValues(
            "messenger.messaging.send-batch-size=8",
            "messenger.messaging.receive-timeout=2ms",
            "messenger.messaging.batch-receive-timeout=10ms",
            "messenger.messaging.quorum-initial-group-size=5",
            "messenger.messaging.failed-delivery-retry-min-delay=500ms",
            "messenger.messaging.failed-delivery-retry-max-delay=1m",
        ).run { context ->
            assertThat(context).hasNotFailed()
            val properties = context.getBean(MessagingProperties::class.java)
            assertThat(properties.sendBatchSize).isEqualTo(8)
            assertThat(properties.receiveTimeout).isEqualTo(Duration.ofMillis(2))
            assertThat(properties.batchReceiveTimeout).isEqualTo(Duration.ofMillis(10))
            assertThat(properties.quorumInitialGroupSize).isEqualTo(5)
            assertThat(properties.failedDeliveryRetryMinDelay).isEqualTo(Duration.ofMillis(500))
            assertThat(properties.failedDeliveryRetryMaxDelay).isEqualTo(Duration.ofMinutes(1))
        }
    }

    @Test
    fun `invalid messaging settings fail at configuration binding`() {
        for (property in listOf(
            "messenger.messaging.delivery-limit=0",
            "messenger.messaging.max-queue-length=0",
            "messenger.messaging.send-batch-size=0",
            "messenger.messaging.send-batch-size=17",
            "messenger.messaging.receive-timeout=0ms",
            "messenger.messaging.batch-receive-timeout=0ms",
            "messenger.messaging.quorum-initial-group-size=0",
            "messenger.messaging.failed-delivery-retry-min-delay=0ms",
            "messenger.messaging.failed-delivery-retry-max-delay=500ms",
        )) {
            runner.withPropertyValues(property).run { context ->
                assertThat(context).hasFailed()
            }
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(MessagingProperties::class)
    class PropertiesConfiguration
}
