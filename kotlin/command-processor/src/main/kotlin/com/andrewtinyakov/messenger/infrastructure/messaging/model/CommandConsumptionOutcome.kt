package com.andrewtinyakov.messenger.infrastructure.messaging.model

internal enum class CommandConsumptionOutcome {
    PERMANENT_FAILURE,
    RETRY,
    ACKNOWLEDGED,
    ;

    val metricValue: String get() = name.lowercase()
}
