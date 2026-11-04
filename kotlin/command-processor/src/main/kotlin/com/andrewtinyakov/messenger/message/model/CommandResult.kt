package com.andrewtinyakov.messenger.message.model

enum class CommandResult(
    val metricValue: String,
) {
    SAVED("saved"),
    REJECTED("rejected"),
    CONFLICT("conflict"),
    DUPLICATE("duplicate"),
}
