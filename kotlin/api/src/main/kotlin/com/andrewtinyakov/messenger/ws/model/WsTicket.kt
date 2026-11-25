package com.andrewtinyakov.messenger.ws.model

import java.time.Instant

data class WsTicket(
    val token: String,
    val expiresAt: Instant,
)
