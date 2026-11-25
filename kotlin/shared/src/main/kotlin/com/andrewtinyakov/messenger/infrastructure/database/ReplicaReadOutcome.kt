package com.andrewtinyakov.messenger.infrastructure.database

enum class ReplicaReadOutcome(
    val metricValue: String,
) {
    SERVED("served"),
    REJECTED("rejected"),
    UNAVAILABLE("unavailable"),
    FAILED("failed"),
}
