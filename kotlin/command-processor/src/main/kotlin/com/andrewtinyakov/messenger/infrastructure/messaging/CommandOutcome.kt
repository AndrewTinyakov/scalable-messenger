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

internal enum class CommandAcknowledgementOperation {
    ACK,
    REJECT,
    ;

    val metricValue: String get() = name.lowercase()
}

internal enum class CommandAcknowledgementResult {
    SUCCESS,
    FAILURE,
    ;

    val metricValue: String get() = name.lowercase()
}
