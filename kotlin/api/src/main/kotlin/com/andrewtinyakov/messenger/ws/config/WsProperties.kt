package com.andrewtinyakov.messenger.ws.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.nio.charset.StandardCharsets

@ConfigurationProperties("messenger.ws")
data class WsProperties(
    val ticketSecret: String,
) {
    init {
        require(ticketSecret.toByteArray(StandardCharsets.UTF_8).size >= 32) { "WS ticket secret must have at least 32 bytes" }
    }
}
