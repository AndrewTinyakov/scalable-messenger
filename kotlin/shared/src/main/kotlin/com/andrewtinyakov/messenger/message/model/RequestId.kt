package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.shared.id.isValidId
import com.andrewtinyakov.messenger.shared.id.requireId

@JvmInline
value class RequestId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid request ID" }
    }

    companion object {
        fun parse(value: String) = RequestId(requireId(value))
    }
}
