package com.andrewtinyakov.messenger.infrastructure.messaging.model

internal enum class CommandProcessingOutcome {
    FAILED,
    ACKNOWLEDGED,
    ;

    val metricValue: String get() = name.lowercase()
}
