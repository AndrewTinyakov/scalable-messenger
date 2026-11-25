package com.andrewtinyakov.messenger.message.monitoring

enum class SendBatchOutcome {
    COMMITTED,
    ROLLED_BACK,
    UNKNOWN,
    ;

    val metricValue: String get() = name.lowercase()
}
