package com.andrewtinyakov.messenger.infrastructure.outbox.metrics

enum class OutboxPublicationOutcome(
    val metricValue: String,
) {
    SUCCESS("success"),
    FAILURE("failure"),
}
