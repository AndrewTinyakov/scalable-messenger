package com.andrewtinyakov.messenger.ws.web.payload

import io.swagger.v3.oas.annotations.media.Schema

data class WsTicketResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val token: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val expiresAt: Long,
)
