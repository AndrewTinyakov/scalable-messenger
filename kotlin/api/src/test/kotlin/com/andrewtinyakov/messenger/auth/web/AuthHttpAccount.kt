package com.andrewtinyakov.messenger.auth.web

data class AuthHttpAccount(
    val userId: String,
    val cookie: String,
    val deviceId: String,
    val sessionId: String,
)
