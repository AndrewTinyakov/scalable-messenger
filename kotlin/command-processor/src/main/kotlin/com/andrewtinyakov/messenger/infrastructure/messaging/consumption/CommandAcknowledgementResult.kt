package com.andrewtinyakov.messenger.infrastructure.messaging.consumption

internal enum class CommandAcknowledgementResult {
    SUCCESS,
    FAILURE,
    ;

    val metricValue: String get() = name.lowercase()
}
