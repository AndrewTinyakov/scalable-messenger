package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.messaging.SessionOutbox
import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.DeviceId
import com.andrewtinyakov.messenger.auth.model.DeviceLabel
import com.andrewtinyakov.messenger.auth.model.ExpectedSessionIdentity
import com.andrewtinyakov.messenger.auth.model.LoginAttempt
import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.auth.model.SessionToken
import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.tooManyAttempts
import com.andrewtinyakov.messenger.shared.web.unauthorized
import org.springframework.dao.DuplicateKeyException
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime
import java.util.UUID

@Service
class AuthenticationService(
    private val userRepository: UserRepository,
    private val sessionRepository: SessionRepository,
    private val passwordEncoder: PasswordEncoder,
    private val loginThrottleService: LoginThrottleService,
    private val sessionOutbox: SessionOutbox,
    private val sessionIssuanceService: SessionIssuanceService,
    private val clock: Clock,
    private val tx: TransactionTemplate,
) {
    private val rejectedPasswordHash = requireNotNull(passwordEncoder.encode(UUID.randomUUID().toString()))

    fun register(username: String, password: String, deviceId: String? = null, userAgent: String? = null): SessionCredentials {
        val device = validateInput(password = password, deviceId = deviceId)
        val normalized = normalize(username)
        if (!User.isValidUsername(normalized)) {
            invalidInput("username", "Use letters, digits, or underscore")
        }
        val user = User(
            id = UserId(newId()),
            username = normalized,
            passwordHash = requireNotNull(passwordEncoder.encode(password)),
        )
        try {
            return tx.execute {
                userRepository.insertUser(user = user)
                sessionIssuanceService.issue(user = user, requestedDeviceId = device, deviceLabel = DeviceLabel.fromUserAgent(userAgent))
            }
        } catch (_: DuplicateKeyException) {
            conflict(ApiErrorCode.USERNAME_TAKEN, "Username already exists")
        }
    }

    fun login(
        username: String,
        password: String,
        deviceId: String? = null,
        userAgent: String? = null,
        clientIp: String? = null,
    ): SessionCredentials {
        val device = validateInput(password = password, deviceId = deviceId)
        val normalized = normalize(username)
        val attempt = loginThrottleService.reserveAttempt(username = normalized, clientIp = clientIp)
        if (attempt is LoginAttempt.Blocked) tooManyAttempts(attempt.retryAfter)
        val user = userRepository.findUserByUsername(username = normalized)
        val matches = passwordEncoder.matches(password, user?.passwordHash ?: rejectedPasswordHash)
        if (user == null || !matches) {
            unauthorized(ApiErrorCode.INVALID_CREDENTIALS, "Invalid username or password")
        }
        val upgradedHash = if (passwordEncoder.upgradeEncoding(user.passwordHash)) passwordEncoder.encode(password) else null
        val credentials = tx.execute {
            if (userRepository.lockPasswordHash(userId = user.id) != user.passwordHash) {
                unauthorized(ApiErrorCode.INVALID_CREDENTIALS, "Invalid username or password")
            }
            upgradedHash?.let { userRepository.replacePasswordHash(userId = user.id, expectedHash = user.passwordHash, newHash = it) }
            sessionIssuanceService.issue(user = user, requestedDeviceId = device, deviceLabel = DeviceLabel.fromUserAgent(userAgent))
        }
        loginThrottleService.clear(username = normalized, clientIp = clientIp)
        return credentials
    }

    fun authenticatedSession(token: SessionToken?): AuthenticatedSession =
        sessionIfActive(token) ?: unauthorized(ApiErrorCode.UNAUTHORIZED, "Session expired or invalid")

    fun sessionIfActive(token: SessionToken?): AuthenticatedSession? =
        token?.let { sessionRepository.findSession(sessionId = it.sessionId(), now = OffsetDateTime.now(clock)) }

    fun logout(token: SessionToken?, expectedIdentity: ExpectedSessionIdentity = ExpectedSessionIdentity()) {
        if (token == null) return
        val sessionId = token.sessionId()
        tx.executeWithoutResult {
            val session = sessionRepository.deleteSession(sessionId = sessionId) ?: return@executeWithoutResult
            if (session.expiresAt > clock.instant()) requireExpectedIdentity(expectedIdentity = expectedIdentity, session = session)
            sessionOutbox.enqueueRevoked(userId = session.userId, sessionIds = listOf(sessionId))
        }
    }

    fun requireExpectedIdentity(expectedIdentity: ExpectedSessionIdentity, session: AuthenticatedSession) {
        if (!expectedIdentity.matches(session)) {
            unauthorized(ApiErrorCode.UNAUTHORIZED, "Session identity changed")
        }
    }

    private fun normalize(username: String): String {
        val normalized = username.trim().lowercase()
        if (normalized.length !in User.MIN_USERNAME_LENGTH..User.MAX_USERNAME_LENGTH) {
            invalidInput(
                "username",
                "Username must be ${User.MIN_USERNAME_LENGTH} to ${User.MAX_USERNAME_LENGTH} characters",
            )
        }
        return normalized
    }

    private fun validateInput(password: String, deviceId: String?): DeviceId? {
        if (!User.isValidPassword(password)) invalidPassword()
        if (deviceId != null && (deviceId.isBlank() || deviceId.length !in 1..DeviceId.MAX_LENGTH)) {
            invalidInput("deviceId", "deviceId must be 1 to ${DeviceId.MAX_LENGTH} characters")
        }
        return deviceId?.let(::DeviceId)
    }

    private fun invalidPassword(): Nothing = invalidInput(
        "password",
        "Password must be ${User.MIN_PASSWORD_LENGTH} to ${User.MAX_PASSWORD_LENGTH} characters",
    )
}
