package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.shared.id.isValidId
import com.andrewtinyakov.messenger.shared.id.requireId

@JvmInline
value class ChatId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid chat ID" }
    }

    companion object {
        fun parse(value: String) = ChatId(requireId(value))
    }
}
