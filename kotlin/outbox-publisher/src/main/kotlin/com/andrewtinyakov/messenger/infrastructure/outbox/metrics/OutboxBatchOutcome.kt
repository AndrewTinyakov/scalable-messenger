package com.andrewtinyakov.messenger.infrastructure.outbox.metrics

enum class OutboxBatchOutcome(
    val metricValue: String,
) {
    EMPTY("empty"),
    WORK("work"),
    FAILED("failed"),
}
