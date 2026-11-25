package com.andrewtinyakov.messenger.auth.config

import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.time.Duration

class AuthPropertiesTests {
    @Test
    fun `a retired session grace must end before renewal could extend it`() {
        AuthProperties(sessionRenewalInterval = Duration.ofMinutes(2), retiredSessionGrace = Duration.ofMinutes(1))
        assertThrows(IllegalArgumentException::class.java) {
            AuthProperties(sessionRenewalInterval = Duration.ofSeconds(30), retiredSessionGrace = Duration.ofMinutes(1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AuthProperties(sessionRenewalInterval = Duration.ZERO)
        }
    }
}
