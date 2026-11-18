package com.andrewtinyakov.messenger.ws.service

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.unauthorized
import com.andrewtinyakov.messenger.ws.config.WsProperties
import com.andrewtinyakov.messenger.ws.model.TicketClaims
import com.andrewtinyakov.messenger.ws.model.TicketHeader
import com.andrewtinyakov.messenger.ws.model.WsTicket
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private const val TICKET_ISSUER = "messenger-api"
private const val TICKET_AUDIENCE = "messenger-ws"
private const val JWT_ALGORITHM = "HS256"
private const val JWT_TYPE = "JWT"
private val TICKET_LIFETIME = Duration.ofHours(1)

@Service
class WsTicketService(
    properties: WsProperties,
    private val mapper: ObjectMapper,
    private val clock: Clock,
) {
    private val key = properties.ticketSecret.toByteArray(StandardCharsets.UTF_8)
    private val encoder = Base64.getUrlEncoder().withoutPadding()

    fun issue(session: AuthenticatedSession): WsTicket {
        val now = clock.instant()
        val expiry = minOf(now.plus(TICKET_LIFETIME), session.expiresAt).epochSecond
        if (expiry <= now.epochSecond) unauthorized(ApiErrorCode.UNAUTHORIZED, "Invalid WS ticket")
        val header = encoder.encodeToString(mapper.writeValueAsBytes(TicketHeader(alg = JWT_ALGORITHM, typ = JWT_TYPE)))
        val body = encoder.encodeToString(
            mapper.writeValueAsBytes(
                TicketClaims(
                    iss = TICKET_ISSUER,
                    aud = TICKET_AUDIENCE,
                    sub = session.userId.value,
                    deviceId = session.deviceId.value,
                    sid = session.sessionId.value,
                    exp = expiry,
                ),
            ),
        )
        val signed = "$header.$body"
        return WsTicket(token = "$signed.${encoder.encodeToString(sign(signed))}", expiresAt = Instant.ofEpochSecond(expiry))
    }

    private fun sign(input: String): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(input.toByteArray(StandardCharsets.US_ASCII))
    }
}
