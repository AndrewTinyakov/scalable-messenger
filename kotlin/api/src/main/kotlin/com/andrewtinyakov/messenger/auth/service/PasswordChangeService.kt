package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.messaging.SessionOutbox
import com.andrewtinyakov.messenger.auth.model.DeviceLabel
import com.andrewtinyakov.messenger.auth.model.LoginAttempt
import com.andrewtinyakov.messenger.auth.model.PasswordChange
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.tooManyAttempts
import com.andrewtinyakov.messenger.shared.web.unauthorized
import org.springframework.http.HttpStatus
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Service
class PasswordChangeService(
    private val userRepository: UserRepository,
    private val sessionRepository: SessionRepository,
    private val passwordEncoder: PasswordEncoder,
    private val loginThrottleService: LoginThrottleService,
    private val sessionOutbox: SessionOutbox,
    private val sessionIssuanceService: SessionIssuanceService,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val properties: AuthProperties,
) {
    fun changePassword(
        userId: UserId,
        currentSessionId: SessionId,
        currentPassword: String,
        newPassword: String,
        clientIp: String? = null,
        userAgent: String? = null,
    ): PasswordChange {
        if (currentPassword.isEmpty() || currentPassword.length > User.MAX_PASSWORD_LENGTH) {
            invalidInput("currentPassword", "Enter your current password")
        }
        if (!User.isValidPassword(newPassword)) {
            invalidInput(
                "newPassword",
                "Password must be ${User.MIN_PASSWORD_LENGTH} to ${User.MAX_PASSWORD_LENGTH} characters",
            )
        }
        val user = userRepository.findUser(userId = userId) ?: unauthorized(ApiErrorCode.UNAUTHORIZED, "Session expired or invalid")
        val attempt = loginThrottleService.reserveAttempt(username = user.username, clientIp = clientIp)
        if (attempt is LoginAttempt.Blocked) tooManyAttempts(attempt.retryAfter)
        if (!passwordEncoder.matches(currentPassword, user.passwordHash)) {
            throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.INVALID_CREDENTIALS, "Current password is incorrect")
        }
        val newHash = requireNotNull(passwordEncoder.encode(newPassword))
        val change = tx.execute {
            if (!userRepository.replacePasswordHash(userId = user.id, expectedHash = user.passwordHash, newHash = newHash)) {
                conflict(ApiErrorCode.PASSWORD_CHANGED, "Your password was changed elsewhere. Try again.")
            }
            val others = sessionRepository.deleteOtherUserSessions(userId = user.id, keptSessionId = currentSessionId)
            val now = OffsetDateTime.now(clock)
            val current = sessionRepository.retireUserSession(
                userId = user.id,
                sessionId = currentSessionId,
                now = now,
                until = now.plus(properties.retiredSessionGrace),
            ) ?: unauthorized(ApiErrorCode.UNAUTHORIZED, "Session expired or invalid")
            sessionOutbox.enqueueRevoked(userId = user.id, sessionIds = others + currentSessionId)
            PasswordChange(
                credentials = sessionIssuanceService.issue(
                    user = user,
                    requestedDeviceId = current.deviceId,
                    deviceLabel = DeviceLabel.fromUserAgent(userAgent),
                ),
                revokedOtherSessions = others.size,
            )
        }
        loginThrottleService.clear(username = user.username, clientIp = clientIp)
        return change
    }
}
