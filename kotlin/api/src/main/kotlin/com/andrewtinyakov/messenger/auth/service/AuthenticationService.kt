package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.Session
import com.andrewtinyakov.messenger.auth.repository.AuthRepository
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.auth.web.payload.AuthResponse
import com.andrewtinyakov.messenger.auth.web.payload.SessionResponse
import com.andrewtinyakov.messenger.generated.messaging.event.SessionRevokedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxWriter
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.user.web.payload.UserResponse
import org.jooq.exception.DataAccessException
import org.springframework.http.HttpStatus
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.security.SecureRandom
import java.time.Clock
import java.time.OffsetDateTime
import java.util.Base64
import java.util.UUID

@Service
class AuthenticationService(
    private val repository: AuthRepository,
    private val encoder: PasswordEncoder,
    private val clock: Clock,
    private val tx: TransactionTemplate,
    private val outbox: OutboxWriter,
    private val mapper: ObjectMapper,
) {
    private val random = SecureRandom()

    fun register(input: AuthRequest): AuthResponse {
        val username = input.username.trim().lowercase()
        if (!Regex("[a-z0-9_]{3,40}").matches(username)) {
            badRequest(ApiErrorCode.INVALID_USERNAME, "Use letters, digits, or underscore")
        }
        val user = UserResponse(newId(), username)
        val passwordHash = requireNotNull(encoder.encode(input.password))
        try {
            return tx.execute {
                repository.insertUser(user.id, user.username, passwordHash)
                issue(user, input.deviceId)
            }
        } catch (error: DataAccessException) {
            if (error.sqlState() != "23505") throw error
            conflict(ApiErrorCode.USERNAME_TAKEN, "Username already exists")
        }
    }

    fun login(input: AuthRequest): AuthResponse {
        val username = input.username.trim().lowercase()
        val row = repository.findUserByUsername(username)
        if (row == null || !encoder.matches(input.password, row.passwordHash)) {
            throw ApiException(HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_CREDENTIALS, "Invalid username or password")
        }
        return issue(UserResponse(row.id, row.username), input.deviceId)
    }

    fun session(authorization: String?): SessionResponse = authenticatedSession(authorization).let {
        SessionResponse(it.userId, it.username, it.deviceId)
    }

    fun authenticatedSession(authorization: String?): Session {
        val tokenHash = sha256(requireBearer(authorization))
        return repository.findSession(tokenHash, OffsetDateTime.now(clock))
            ?: throw ApiException(HttpStatus.UNAUTHORIZED, ApiErrorCode.UNAUTHORIZED, "Session expired or invalid")
    }

    fun activeTicketSession(sessionId: String, userId: String, deviceId: String): Boolean =
        repository.isActiveSession(sessionId, userId, deviceId, OffsetDateTime.now(clock))

    fun logout(authorization: String?) {
        val sessionId = sha256(requireBearer(authorization))
        tx.executeWithoutResult {
            val userId = repository.deleteSession(sessionId) ?: return@executeWithoutResult
            val event = SessionRevokedEventV1(
                type = "session_revoked",
                version = 1,
                eventId = newId(),
                room = "user:$userId",
                sessionId = sessionId,
            )
            outbox.enqueue(event.eventId, event.room, mapper.writeValueAsString(event))
        }
    }

    private fun requireBearer(authorization: String?): String =
        authorization?.takeIf { it.startsWith("Bearer ") && it.length > 7 }?.removePrefix("Bearer ")
            ?: throw ApiException(HttpStatus.UNAUTHORIZED, ApiErrorCode.UNAUTHORIZED, "Bearer token required")

    private fun issue(user: UserResponse, requestedDeviceId: String?): AuthResponse {
        if (requestedDeviceId != null && requestedDeviceId.length !in 1..64) {
            badRequest(ApiErrorCode.INVALID_DEVICE_ID, "deviceId must be 1 to 64 characters")
        }
        val deviceId = requestedDeviceId ?: UUID.randomUUID().toString()
        val bytes = ByteArray(32).also(random::nextBytes)
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        repository.insertSession(sha256(token), user.id, deviceId, OffsetDateTime.now(clock).plusDays(30))
        return AuthResponse(token, user, deviceId)
    }
}
