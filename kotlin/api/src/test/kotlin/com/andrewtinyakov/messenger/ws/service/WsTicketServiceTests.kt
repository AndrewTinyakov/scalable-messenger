package com.andrewtinyakov.messenger.ws.service

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.DeviceId
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.ws.config.WsProperties
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import tools.jackson.module.kotlin.jacksonObjectMapper
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64

class WsTicketServiceTests {
    private val mapper = jacksonObjectMapper()
    private val now = Instant.parse("2026-09-28T12:00:00Z")
    private val secret = "ticket-test-secret-with-at-least-32-bytes"
    private val session =
        AuthenticatedSession(
            userId = UserId(newId()),
            deviceId = DeviceId("device-1"),
            sessionId = SessionId("a".repeat(64)),
            expiresAt = now.plus(Duration.ofDays(30)),
        )

    @Test
    fun `ticket uses the expected wire claims`() {
        val tickets = WsTicketService(WsProperties(secret), mapper, Clock.fixed(now, ZoneOffset.UTC))
        val issued = tickets.issue(session)
        val parts = issued.token.split('.')
        val decoder = Base64.getUrlDecoder()
        val header = mapper.readTree(decoder.decode(parts[0]))
        val claims = mapper.readTree(decoder.decode(parts[1]))

        assertEquals(3, parts.size)
        assertEquals(setOf("alg", "typ"), header.properties().asSequence().map { it.key }.toSet())
        assertEquals("HS256", header.path("alg").stringValue())
        assertEquals("JWT", header.path("typ").stringValue())
        assertEquals(setOf("iss", "aud", "sub", "deviceId", "sid", "exp"), claims.properties().asSequence().map { it.key }.toSet())
        assertEquals("messenger-api", claims.path("iss").stringValue())
        assertEquals("messenger-ws", claims.path("aud").stringValue())
        assertEquals(session.userId.value, claims.path("sub").stringValue())
        assertEquals(session.deviceId.value, claims.path("deviceId").stringValue())
        assertEquals(session.sessionId.value, claims.path("sid").stringValue())
        assertEquals(now.plus(Duration.ofHours(1)).epochSecond, claims.path("exp").longValue())
    }

    @Test
    fun `ticket expires with its underlying session`() {
        val tickets = WsTicketService(WsProperties(secret), mapper, Clock.fixed(now, ZoneOffset.UTC))
        val sessionExpiry = now.plusSeconds(30)
        val issued = tickets.issue(session.copy(expiresAt = sessionExpiry))

        assertEquals(sessionExpiry.epochSecond, issued.expiresAt)
    }

    @Test
    fun `expired sessions cannot receive tickets`() {
        val tickets = WsTicketService(WsProperties(secret), mapper, Clock.fixed(now, ZoneOffset.UTC))

        assertThrows(ApiException::class.java) { tickets.issue(session.copy(expiresAt = now)) }
        assertThrows(ApiException::class.java) { tickets.issue(session.copy(expiresAt = now.minusSeconds(1))) }
    }
}
