package com.andrewtinyakov.messenger.auth.config

import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm.PBKDF2WithHmacSHA256

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
