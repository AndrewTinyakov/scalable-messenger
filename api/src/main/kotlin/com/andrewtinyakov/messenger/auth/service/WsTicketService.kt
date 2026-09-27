package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.Session
import com.andrewtinyakov.messenger.auth.web.payload.WsTicketResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Clock
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

@Service
class WsTicketService(
    @Value("\${messenger.auth.ws-ticket-secret}") secret: String,
    private val mapper: ObjectMapper,
    private val clock: Clock,
) {
    private val key = secret.toByteArray(StandardCharsets.UTF_8).also {
        require(it.size >= 32) { "WS ticket secret must have at least 32 bytes" }
    }
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    fun issue(session: Session): WsTicketResponse {
        val expiry = clock.instant().epochSecond + 3600
        val header = encoder.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".toByteArray())
        val body = encoder.encodeToString(
            mapper.writeValueAsBytes(
                mapOf(
                    "iss" to "messenger-api",
                    "aud" to "messenger-ws",
                    "sub" to session.userId,
                    "deviceId" to session.deviceId,
                    "sid" to session.sessionId,
                    "exp" to expiry,
                ),
            ),
        )
        val signed = "$header.$body"
        return WsTicketResponse("$signed.${encoder.encodeToString(sign(signed))}", expiry)
    }

    fun verify(ticket: String): VerifiedWsTicket {
        val parts = ticket.split('.')
        if (parts.size != 3 || parts.any { it.isBlank() }) unauthorized()
        val signed = "${parts[0]}.${parts[1]}"
        val actual = try {
            decoder.decode(parts[2])
        } catch (_: IllegalArgumentException) {
            unauthorized()
        }
        if (!MessageDigest.isEqual(sign(signed), actual)) unauthorized()
        val header = try {
            mapper.readTree(decoder.decode(parts[0]))
        } catch (_: Exception) {
            unauthorized()
        }
        if (header.path("alg").asText() != "HS256" || header.path("typ").asText() != "JWT") unauthorized()
        val claims = try {
            mapper.readTree(decoder.decode(parts[1]))
        } catch (_: Exception) {
            unauthorized()
        }
        if (claims.path("iss").asText() != "messenger-api" || claims.path("aud").asText() != "messenger-ws" ||
            claims.path("exp").asLong(0) <= clock.instant().epochSecond ||
            claims.path("sub").asText().isBlank() || claims.path("deviceId").asText().isBlank() ||
            !Regex("[0-9a-f]{64}").matches(claims.path("sid").asText())
        ) {
            unauthorized()
        }
        return VerifiedWsTicket(claims.path("sub").asText(), claims.path("deviceId").asText(), claims.path("sid").asText())
    }

    private fun sign(input: String): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(input.toByteArray(StandardCharsets.US_ASCII))
    }

    private fun unauthorized(): Nothing = throw ApiException(HttpStatus.UNAUTHORIZED, ApiErrorCode.UNAUTHORIZED, "Invalid WS ticket")
}

data class VerifiedWsTicket(
    val userId: String,
    val deviceId: String,
    val sessionId: String,
)
