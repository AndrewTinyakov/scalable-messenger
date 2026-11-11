package com.andrewtinyakov.messenger.auth.model

import com.andrewtinyakov.messenger.shared.id.isValidId
import com.andrewtinyakov.messenger.shared.id.requireId

@JvmInline
value class UserId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid user ID" }
    }

    companion object {
        fun parse(value: String) = UserId(requireId(value))
    }
}
