package com.andrewtinyakov.messenger.message.monitoring

enum class MessageEditFailure(
    val metricValue: String,
) {
    FORBIDDEN("forbidden"),
    CONFLICT("conflict"),
    ERROR("failed"),
}
