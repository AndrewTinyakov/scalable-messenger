package com.andrewtinyakov.messenger.infrastructure.outbox.monitoring

enum class OutboxStageOutcome(
    val metricValue: String,
) {
    SUCCESS("success"),
    FAILURE("failure"),
    DEADLINE("deadline"),
    CANCELLED("cancelled"),
}
