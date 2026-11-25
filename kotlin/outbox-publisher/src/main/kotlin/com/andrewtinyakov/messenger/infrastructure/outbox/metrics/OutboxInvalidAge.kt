package com.andrewtinyakov.messenger.infrastructure.outbox.metrics

internal enum class OutboxInvalidAge(
    val metricValue: String,
) {
    MISSING("missing"),
    FUTURE("future"),
}
