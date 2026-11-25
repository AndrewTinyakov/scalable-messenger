package com.andrewtinyakov.messenger.infrastructure.database

internal enum class TransactionCompletionPhase(
    val metricValue: String,
) {
    COMMIT("commit"),
    ROLLBACK("rollback"),
}
