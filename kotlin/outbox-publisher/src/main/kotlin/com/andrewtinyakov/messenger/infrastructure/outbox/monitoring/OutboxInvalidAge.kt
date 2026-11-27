package com.andrewtinyakov.messenger.infrastructure.outbox.monitoring

internal enum class OutboxInvalidAge(
    val metricValue: String,
) {
    MISSING("missing"),
    FUTURE("future"),
}
