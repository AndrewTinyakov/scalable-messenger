package com.andrewtinyakov.messenger.infrastructure.messaging.model

internal enum class CommandAcknowledgementOperation {
    ACK,
    REJECT,
    ;

    val metricValue: String get() = name.lowercase()
}
