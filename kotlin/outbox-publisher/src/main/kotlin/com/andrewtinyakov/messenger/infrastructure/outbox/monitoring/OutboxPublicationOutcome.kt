package com.andrewtinyakov.messenger.infrastructure.outbox.monitoring

enum class OutboxPublicationOutcome(
    val metricValue: String,
) {
    SUCCESS("success"),
    FAILURE("failure"),
}
