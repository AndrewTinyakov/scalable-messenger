package com.andrewtinyakov.messenger.auth.model

@JvmInline
value class DeviceId(
    val value: String,
) {
    init {
        require(value.isNotBlank() && value.length <= 64) { "Invalid device ID" }
    }
}
