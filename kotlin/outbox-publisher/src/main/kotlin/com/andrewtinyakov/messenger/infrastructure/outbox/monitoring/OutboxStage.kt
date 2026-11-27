package com.andrewtinyakov.messenger.infrastructure.outbox.monitoring

enum class OutboxStage(
    val metricValue: String,
) {
    CLAIM("claim"),
    HYDRATE("hydrate"),
    PUBLISH("publish"),
    COMPLETE("complete"),
}
