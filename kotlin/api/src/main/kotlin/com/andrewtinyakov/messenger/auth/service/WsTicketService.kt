package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.web.payload.WsTicketResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.unauthorized
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Duration
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private const val TICKET_ISSUER = "messenger-api"
private const val TICKET_AUDIENCE = "messenger-ws"
private const val JWT_ALGORITHM = "HS256"
private const val JWT_TYPE = "JWT"

private data class TicketHeader(
    val alg: String,
    val typ: String,
)

private data class TicketClaims(
    val iss: String,
    val aud: String,
    val sub: String,
    val deviceId: String,
    val sid: String,
    val exp: Long,
)

@Service
class WsTicketService(
    properties: AuthProperties,
    private val mapper: ObjectMapper,
    private val clock: Clock,
) {
    private val key = properties.wsTicketSecret.toByteArray(StandardCharsets.UTF_8)
    private val encoder = Base64.getUrlEncoder().withoutPadding()

    fun issue(session: AuthenticatedSession): WsTicketResponse {
        val now = clock.instant()
        val expiry = minOf(now.plus(Duration.ofHours(1)), session.expiresAt).epochSecond
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
        return WsTicketResponse(token = "$signed.${encoder.encodeToString(sign(signed))}", expiresAt = expiry)
    }

    private fun sign(input: String): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(input.toByteArray(StandardCharsets.US_ASCII))
    }
}
