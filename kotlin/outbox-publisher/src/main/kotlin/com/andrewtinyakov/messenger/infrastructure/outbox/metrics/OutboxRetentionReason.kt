package com.andrewtinyakov.messenger.infrastructure.outbox.metrics

enum class OutboxRetentionReason(
    val metricValue: String,
) {
    COMPLETE_FAILURE("complete_failure"),
    INTERRUPTED("interrupted"),
    DEADLINE("deadline"),
    PUBLISH_FAILURE("publish_failure"),
}
