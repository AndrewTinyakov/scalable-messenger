package com.andrewtinyakov.messenger.auth.config

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm.PBKDF2WithHmacSHA256

@ConfigurationProperties("messenger.auth.password")
data class PasswordProperties(
    val idForEncode: String = "pbkdf2-sha256-600000",
    val pbkdf2: Map<String, Pbkdf2Properties> = mapOf("pbkdf2-sha256-600000" to Pbkdf2Properties()),
) {
    init {
        require(idForEncode in pbkdf2)
        require(pbkdf2.keys.all { it.isNotBlank() && it != "bcrypt" && '{' !in it && '}' !in it })
    }

    data class Pbkdf2Properties(
        val saltLength: Int = 16,
        val iterations: Int = 600_000,
        val algorithm: Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm = PBKDF2WithHmacSHA256,
        val encodeHashAsBase64: Boolean = true,
    ) {
        init {
            require(saltLength >= 16)
            require(iterations > 0)
        }
    }
}
