package com.andrewtinyakov.messenger.generated.messaging.event


data class SessionRevokedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val sessionId: String,
)