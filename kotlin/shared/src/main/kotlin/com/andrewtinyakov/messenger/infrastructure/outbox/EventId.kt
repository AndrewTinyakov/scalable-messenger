package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.shared.id.isValidId

@JvmInline
value class EventId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid event ID" }
    }
}
