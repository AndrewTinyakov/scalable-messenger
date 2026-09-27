package com.andrewtinyakov.messenger.auth.model

data class Session(
    val userId: String,
    val username: String,
    val deviceId: String,
    val sessionId: String,
)
