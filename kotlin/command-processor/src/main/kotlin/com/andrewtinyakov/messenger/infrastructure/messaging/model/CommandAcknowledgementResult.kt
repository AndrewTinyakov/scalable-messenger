package com.andrewtinyakov.messenger.infrastructure.messaging.model

internal enum class CommandAcknowledgementResult {
    SUCCESS,
    FAILURE,
    ;

    val metricValue: String get() = name.lowercase()
}
