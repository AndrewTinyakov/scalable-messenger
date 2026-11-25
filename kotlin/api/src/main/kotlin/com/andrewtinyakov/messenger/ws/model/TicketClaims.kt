package com.andrewtinyakov.messenger.ws.model

internal data class TicketClaims(
    val iss: String,
    val aud: String,
    val sub: String,
    val deviceId: String,
    val sid: String,
    val exp: Long,
)
