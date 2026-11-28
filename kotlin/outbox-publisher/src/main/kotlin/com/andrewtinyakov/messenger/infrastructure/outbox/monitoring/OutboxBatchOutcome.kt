package com.andrewtinyakov.messenger.infrastructure.outbox.monitoring

enum class OutboxBatchOutcome(
    val metricValue: String,
) {
    EMPTY("empty"),
    WORK("work"),
    FAILED("failed"),
}
