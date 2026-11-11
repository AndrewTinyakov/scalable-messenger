package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.shared.id.isValidId

@JvmInline
value class RequestId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid request ID" }
    }
}
