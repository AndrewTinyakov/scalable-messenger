package com.andrewtinyakov.messenger.auth.config

import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm.PBKDF2WithHmacSHA512

class PasswordPersistenceTests : MessengerIntegrationTest() {
    @Autowired
    private lateinit var userRepository: UserRepository

    @Test
    fun `configured hashes longer than one hundred characters survive persistence`() {
        val settings = listOf(
            PasswordProperties.Pbkdf2Properties(iterations = 1000, algorithm = PBKDF2WithHmacSHA512),
            PasswordProperties.Pbkdf2Properties(iterations = 1000, encodeHashAsBase64 = false),
        )
        for (encoding in settings) {
            val encoder = PasswordConfig().passwordEncoder(
                PasswordProperties(idForEncode = "pbkdf2-next", pbkdf2 = mapOf("pbkdf2-next" to encoding)),
            )
            val id = newId()
            val password = "configured-password"
            val hash = requireNotNull(encoder.encode(password))
            val user = User(UserId(id), "hash_${id.lowercase()}", hash)
            assertTrue(hash.length > 100)

            userRepository.insertUser(user = user)
            val stored = requireNotNull(userRepository.findUserByUsername(username = user.username))

            assertEquals(user, stored)
            assertTrue(encoder.matches(password, stored.passwordHash))
            assertFalse(encoder.matches("incorrect-password", stored.passwordHash))
        }
    }
}
