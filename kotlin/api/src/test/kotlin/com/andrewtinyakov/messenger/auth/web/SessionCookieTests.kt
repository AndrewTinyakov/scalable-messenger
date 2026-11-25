package com.andrewtinyakov.messenger.auth.web

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.model.SessionToken
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.boot.webmvc.autoconfigure.WebMvcProperties
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import java.time.Duration

class SessionCookieTests {
    private val token = SessionToken("A".repeat(43))
    private val mvc = WebMvcProperties().apply { servlet.path = "/api" }

    @Test
    fun `secure cookies use the host prefix with the root path and no domain`() {
        val cookie = cookie(secure = true)
        val response = MockHttpServletResponse()

        cookie.issue(response, token)

        val header = response.getHeader("Set-Cookie")!!
        assertTrue(header.startsWith("__Host-messenger_session=${token.value};"), header)
        assertTrue(header.contains("; Path=/;"), header)
        assertTrue(header.contains("; Max-Age=${Duration.ofDays(400).seconds};"), header)
        assertTrue(header.contains("; Secure"), header)
        assertTrue(header.contains("; HttpOnly"), header)
        assertTrue(header.contains("; SameSite=Strict"), header)
        assertFalse(header.contains("Domain="), header)
    }

    @Test
    fun `plain HTTP development keeps the unprefixed cookie under the API path`() {
        val cookie = cookie(secure = false)
        val response = MockHttpServletResponse()

        cookie.issue(response, token)

        val header = response.getHeader("Set-Cookie")!!
        assertTrue(header.startsWith("messenger_session=${token.value};"), header)
        assertTrue(header.contains("; Path=/api;"), header)
        assertFalse(header.contains("Secure"), header)
    }

    @Test
    fun `each mode reads only its own cookie name and clears it with the same attributes`() {
        for (secure in listOf(true, false)) {
            val cookie = cookie(secure)
            val other = if (secure) SessionCookie.NAME else SessionCookie.SECURE_NAME
            val foreign = MockHttpServletRequest().apply { setCookies(Cookie(other, token.value)) }
            val own = MockHttpServletRequest().apply { setCookies(Cookie(cookie.name, token.value)) }

            assertNull(cookie.read(foreign))
            assertEquals(token, cookie.read(own))

            val response = MockHttpServletResponse()
            cookie.clear(response)
            val header = response.getHeader("Set-Cookie")!!
            assertTrue(header.startsWith("${cookie.name}=;"), header)
            assertTrue(header.contains("Max-Age=0"), header)
            assertTrue(header.contains(if (secure) "; Path=/;" else "; Path=/api;"), header)
        }
    }

    private fun cookie(secure: Boolean) = SessionCookie(AuthProperties(cookieSecure = secure), mvc)
}
