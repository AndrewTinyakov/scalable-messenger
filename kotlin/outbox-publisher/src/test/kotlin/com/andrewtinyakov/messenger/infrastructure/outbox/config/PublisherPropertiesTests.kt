package com.andrewtinyakov.messenger.infrastructure.outbox.config

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.context.annotation.Configuration

class PublisherPropertiesTests {
    private val runner = ApplicationContextRunner().withUserConfiguration(PropertiesConfiguration::class.java)

    @Test
    fun `publisher settings bind to validated properties`() {
        runner.withPropertyValues(
            "messenger.publisher.poll-ms=250",
            "messenger.publisher.batch-size=20",
            "messenger.publisher.lease-seconds=10",
            "messenger.publisher.concurrency=4",
            "messenger.publisher.batch-bytes=131072",
            "messenger.publisher.publish-timeout-ms=2500",
            "messenger.publisher.room-batch-size=3",
        ).run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context.getBean(PublisherProperties::class.java)).isEqualTo(
                PublisherProperties(
                    pollMs = 250,
                    batchSize = 20,
                    leaseSeconds = 10,
                    concurrency = 4,
                    batchBytes = 131072,
                    publishTimeoutMs = 2500,
                    roomBatchSize = 3,
                ),
            )
        }
    }

    @Test
    fun `invalid publication settings fail at configuration binding`() {
        for (property in listOf(
            "messenger.publisher.poll-ms=99",
            "messenger.publisher.batch-size=501",
            "messenger.publisher.lease-seconds=4",
            "messenger.publisher.concurrency=65",
            "messenger.publisher.batch-bytes=65535",
            "messenger.publisher.publish-timeout-ms=0",
            "messenger.publisher.publish-timeout-ms=7501",
            "messenger.publisher.room-batch-size=0",
            "messenger.publisher.room-batch-size=101",
        )) {
            runner.withPropertyValues(property).run { context ->
                assertThat(context).hasFailed()
            }
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(PublisherProperties::class)
    class PropertiesConfiguration
}
