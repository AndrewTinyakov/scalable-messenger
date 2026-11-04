package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.ExpectedSessionIdentity
import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.generated.messaging.event.SessionRevokedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.DeviceId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.SessionId
import com.andrewtinyakov.messenger.shared.id.SessionToken
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.conflict
import org.springframework.dao.DuplicateKeyException
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
    private val userRepository: UserRepository,
    private val sessionRepository: SessionRepository,
    private val encoder: PasswordEncoder,
    private val clock: Clock,
    private val tx: TransactionTemplate,
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    private val random = SecureRandom()
    private val rejectedPasswordHash = requireNotNull(encoder.encode(UUID.randomUUID().toString()))

    fun register(input: AuthRequest): SessionCredentials {
        validateInput(input)
        val username = input.username.trim().lowercase()
        if (!Regex("[a-z0-9_]{3,40}").matches(username)) {
            badRequest(ApiErrorCode.INVALID_USERNAME, "Use letters, digits, or underscore")
        }
        val user = User(
            id = UserId(newId()),
            username = username,
            passwordHash = requireNotNull(encoder.encode(input.password)),
        )
        try {
            return tx.observedExecute(DatabaseTransaction.AUTH_REGISTER) {
                userRepository.insertUser(user = user)
                issue(user = user, requestedDeviceId = input.deviceId?.let(::DeviceId))
            }
        } catch (_: DuplicateKeyException) {
            conflict(ApiErrorCode.USERNAME_TAKEN, "Username already exists")
        }
    }

    fun login(input: AuthRequest): SessionCredentials {
        validateInput(input)
        val username = input.username.trim().lowercase()
        val user = userRepository.findUserByUsername(username = username)
        val matches = encoder.matches(input.password, user?.passwordHash ?: rejectedPasswordHash)
        if (user == null || !matches) {
            throw ApiException(HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_CREDENTIALS, "Invalid username or password")
        }
        return issue(user = user, requestedDeviceId = input.deviceId?.let(::DeviceId))
    }

    fun authenticatedSession(token: SessionToken?): AuthenticatedSession =
        sessionIfActive(token) ?: throw ApiException(HttpStatus.UNAUTHORIZED, ApiErrorCode.UNAUTHORIZED, "Session expired or invalid")

    fun sessionIfActive(token: SessionToken?): AuthenticatedSession? =
        token?.let { sessionRepository.findSession(sessionId = SessionId(sha256(it.value)), now = OffsetDateTime.now(clock)) }

    fun logout(token: SessionToken?, expectedIdentity: ExpectedSessionIdentity = ExpectedSessionIdentity()) {
        if (token == null) return
        val sessionId = SessionId(sha256(token.value))
        tx.observedExecuteWithoutResult(DatabaseTransaction.AUTH_LOGOUT) {
            val session = sessionRepository.deleteSession(sessionId = sessionId) ?: return@observedExecuteWithoutResult
            if (session.expiresAt > clock.instant()) requireExpectedIdentity(expectedIdentity = expectedIdentity, session = session)
            val event = SessionRevokedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(session.userId),
                sessionId = sessionId.value,
            )
            outboxRepository.enqueue(eventId = EventId(event.eventId), room = event.room, payload = mapper.writeValueAsString(event))
        }
    }

    private fun issue(user: User, requestedDeviceId: DeviceId?): SessionCredentials {
        val deviceId = requestedDeviceId ?: DeviceId(UUID.randomUUID().toString())
        val bytes = ByteArray(32).also(random::nextBytes)
        val token = SessionToken(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes))
        val expiresAt = OffsetDateTime.now(clock).plusDays(30)
        val sessionId = SessionId(sha256(token.value))
        sessionRepository.insertSession(sessionId = sessionId, userId = user.id, deviceId = deviceId, expiresAt = expiresAt)
        return SessionCredentials(
            token = token,
            user = UserSummary(id = user.id, username = user.username),
            session = AuthenticatedSession(
                userId = user.id,
                deviceId = deviceId,
                sessionId = sessionId,
                expiresAt = expiresAt.toInstant(),
            ),
        )
    }

    private fun validateInput(input: AuthRequest) {
        if (input.password.length !in 8..100 || input.password.isBlank()) {
            badRequest(ApiErrorCode.INVALID_REQUEST, "Password must be 8 to 100 characters")
        }
        if (input.deviceId != null && (input.deviceId.isBlank() || input.deviceId.length !in 1..64)) {
            badRequest(ApiErrorCode.INVALID_DEVICE_ID, "deviceId must be 1 to 64 characters")
        }
    }
}

fun requireExpectedIdentity(expectedIdentity: ExpectedSessionIdentity, session: AuthenticatedSession) {
    if (!expectedIdentity.matches(session)) {
        throw ApiException(HttpStatus.UNAUTHORIZED, ApiErrorCode.UNAUTHORIZED, "Session identity changed")
    }
}
