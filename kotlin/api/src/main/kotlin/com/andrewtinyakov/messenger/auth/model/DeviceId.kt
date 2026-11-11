package com.andrewtinyakov.messenger.auth.model

@JvmInline
value class DeviceId(
    val value: String,
) {
    init {
        require(value.isNotBlank() && value.length <= MAX_LENGTH) { "Invalid device ID" }
    }

    companion object {
        const val MAX_LENGTH = 64
    }
}
