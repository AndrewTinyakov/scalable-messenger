package com.andrewtinyakov.messenger.infrastructure.outbox

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import java.time.Duration

class OutboxPublisherPropertiesTests {
    private val runner = ApplicationContextRunner().withUserConfiguration(OutboxPublisherPropertiesTestConfiguration::class.java)

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
            "messenger.publisher.worker-join-timeout=3s",
            "messenger.publisher.room-publication-queue-capacity=50",
        ).run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context.getBean(OutboxPublisherProperties::class.java)).isEqualTo(
                OutboxPublisherProperties(
                    pollInterval = Duration.ofMillis(250),
                    batchSize = 20,
                    lease = Duration.ofSeconds(10),
                    concurrency = 4,
                    batchBytes = 131072,
                    publishTimeout = Duration.ofMillis(2500),
                    roomBatchSize = 3,
                    workerJoinTimeout = Duration.ofSeconds(3),
                    roomPublicationQueueCapacity = 50,
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
            "messenger.publisher.worker-join-timeout=0s",
            "messenger.publisher.room-publication-queue-capacity=0",
        )) {
            runner.withPropertyValues(property).run { context ->
                assertThat(context).hasFailed()
            }
        }
    }
}
