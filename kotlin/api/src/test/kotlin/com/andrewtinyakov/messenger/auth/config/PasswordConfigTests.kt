package com.andrewtinyakov.messenger.auth.config

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder

class PasswordConfigTests {
    @Test
    fun `new encoding settings preserve existing PBKDF2 and bcrypt passwords`() {
        val legacy = Pbkdf2PasswordEncoder("", 16, 600_000, Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm.PBKDF2WithHmacSHA256)
            .apply { setEncodeHashAsBase64(true) }
        val password = "legacy-password"
        val historical = "{pbkdf2-sha256-600000}${legacy.encode(password)}"
        val bcrypt = BCryptPasswordEncoder().encode(password)
        val properties = PasswordProperties(
            idForEncode = "pbkdf2-next",
            pbkdf2 = PasswordProperties().pbkdf2 + ("pbkdf2-next" to Pbkdf2Properties(iterations = 1000)),
        )
        val encoder = PasswordConfig().passwordEncoder(properties)

        for (hash in listOf(historical, bcrypt, "{bcrypt}$bcrypt", encoder.encode(password))) {
            assertTrue(encoder.matches(password, hash))
            assertFalse(encoder.matches("incorrect-password", hash))
        }
    }
}
