package com.andrewtinyakov.messenger.infrastructure.outbox.monitoring

internal enum class OutboxRoomKind(
    val metricValue: String,
) {
    GROUP("group"),
    USER("user"),
}
