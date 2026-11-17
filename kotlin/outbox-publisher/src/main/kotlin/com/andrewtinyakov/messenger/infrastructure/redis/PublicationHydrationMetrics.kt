package com.andrewtinyakov.messenger.infrastructure.redis

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.stereotype.Component

@Component
class PublicationHydrationMetrics(
    registry: MeterRegistry,
) {
    private val saved = Counter.builder("messenger.outbox.hydration")
        .description("Outbox references hydrated to current messages or bodyless recovery hints.")
        .tag("result", "saved").register(registry)
    private val absent = Counter.builder("messenger.outbox.hydration")
        .description("Outbox references hydrated to current messages or bodyless recovery hints.")
        .tag("result", "absent").register(registry)
    private val batchSize = DistributionSummary.builder("messenger.outbox.hydration.batch")
        .description("Distinct message IDs requested in each outbox hydration database batch.").register(registry)

    fun batchRequested(messages: Int) = batchSize.record(messages.toDouble())

    fun saved() = saved.increment()

    fun absent() = absent.increment()
}
