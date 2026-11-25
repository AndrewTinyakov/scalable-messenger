package com.andrewtinyakov.messenger.infrastructure.outbox.metrics

internal enum class OutboxRoomKind(
    val metricValue: String,
) {
    GROUP("group"),
    USER("user"),
}
