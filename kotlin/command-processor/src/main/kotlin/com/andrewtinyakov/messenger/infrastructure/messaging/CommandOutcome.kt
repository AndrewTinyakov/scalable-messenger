package com.andrewtinyakov.messenger.infrastructure.messaging

internal enum class CommandConsumptionOutcome {
    PERMANENT_FAILURE,
    RETRY,
    ACKNOWLEDGED,
    ;

    val metricValue: String get() = name.lowercase()
}

internal enum class CommandProcessingOutcome {
    FAILED,
    ACKNOWLEDGED,
    ;

    val metricValue: String get() = name.lowercase()
}
