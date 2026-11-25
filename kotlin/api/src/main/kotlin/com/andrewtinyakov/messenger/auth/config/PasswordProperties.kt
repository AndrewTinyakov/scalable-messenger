package com.andrewtinyakov.messenger.auth.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.auth.password")
data class PasswordProperties(
    val idForEncode: String = "pbkdf2-sha256-600000",
    val pbkdf2: Map<String, Pbkdf2Properties> = mapOf("pbkdf2-sha256-600000" to Pbkdf2Properties()),
) {
    init {
        require(idForEncode in pbkdf2)
        require(pbkdf2.keys.all { it.isNotBlank() && it != "bcrypt" && '{' !in it && '}' !in it })
    }
}
