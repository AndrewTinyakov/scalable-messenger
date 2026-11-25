package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.DeviceId
import com.andrewtinyakov.messenger.auth.model.DeviceLabel
import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.auth.model.SessionToken
import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import org.springframework.stereotype.Service
import java.security.SecureRandom
import java.time.Clock
import java.time.OffsetDateTime
import java.util.Base64
import java.util.UUID

private const val SESSION_TOKEN_BYTES = 32

@Service
class SessionIssuanceService(
    private val sessionRepository: SessionRepository,
    private val properties: AuthProperties,
    private val clock: Clock,
) {
    private val random = SecureRandom()

    fun issue(user: User, requestedDeviceId: DeviceId?, deviceLabel: DeviceLabel): SessionCredentials {
        val deviceId = requestedDeviceId ?: DeviceId(UUID.randomUUID().toString())
        val bytes = ByteArray(SESSION_TOKEN_BYTES).also(random::nextBytes)
        val token = SessionToken(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes))
        val now = OffsetDateTime.now(clock)
        val expiresAt = now.plus(properties.sessionLifetime)
        val sessionId = token.sessionId()
        sessionRepository.insertSession(
            sessionId = sessionId,
            userId = user.id,
            deviceId = deviceId,
            deviceLabel = deviceLabel,
            now = now,
            expiresAt = expiresAt,
        )
        return SessionCredentials(
            token = token,
            user = UserSummary(id = user.id, username = user.username),
            session = AuthenticatedSession(
                userId = user.id,
                deviceId = deviceId,
                sessionId = sessionId,
                expiresAt = expiresAt.toInstant(),
                lastUsedAt = now.toInstant(),
            ),
        )
    }
}
