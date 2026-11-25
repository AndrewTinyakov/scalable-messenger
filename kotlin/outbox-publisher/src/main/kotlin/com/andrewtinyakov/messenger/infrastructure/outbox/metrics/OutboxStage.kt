package com.andrewtinyakov.messenger.infrastructure.outbox.metrics

enum class OutboxStage(
    val metricValue: String,
) {
    CLAIM("claim"),
    HYDRATE("hydrate"),
    PUBLISH("publish"),
    COMPLETE("complete"),
}
