package com.andrewtinyakov.messenger.auth

import com.andrewtinyakov.messenger.shared.ApiException
import com.andrewtinyakov.messenger.shared.newId
import com.andrewtinyakov.messenger.shared.sha256
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.jooq.exception.DataAccessException
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.security.SecureRandom
import java.time.Clock
import java.time.OffsetDateTime
import java.util.Base64
import java.util.UUID

data class Credentials(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(min = 3, max = 40) val username: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(min = 8, max = 100) val password: String,
    val deviceId: String? = null,
)

data class UserView(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val username: String,
)

data class AuthView(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val token: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val user: UserView,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deviceId: String,
)

data class SessionView(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val userId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val username: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deviceId: String,
)

@Service
class AuthService(
    private val repository: AuthRepository,
    private val encoder: PasswordEncoder,
    private val clock: Clock,
    private val tx: TransactionTemplate,
) {
    private val random = SecureRandom()

    fun register(input: Credentials): AuthView {
        val username = input.username.trim().lowercase()
        if (!username.matches(Regex("[a-z0-9_]{3,40}"))) throw ApiException(400, "INVALID_USERNAME", "Use letters, digits, or underscore")
        val user = UserView(newId(), username)
        val passwordHash = requireNotNull(encoder.encode(input.password))
        try {
            return tx.execute {
                repository.insertUser(user.id, user.username, passwordHash)
                issue(user, input.deviceId)
            }
        } catch (error: DataAccessException) {
            if (error.sqlState() != "23505") throw error
            throw ApiException(409, "USERNAME_TAKEN", "Username already exists")
        }
    }

    fun login(input: Credentials): AuthView {
        val username = input.username.trim().lowercase()
        val row = repository.findUserByUsername(username)
        if (row == null || !encoder.matches(input.password, row.passwordHash)) {
            throw ApiException(401, "INVALID_CREDENTIALS", "Invalid username or password")
        }
        return issue(UserView(row.id, row.username), input.deviceId)
    }

    fun session(authorization: String?): SessionView {
        val token = authorization?.takeIf { it.startsWith("Bearer ") }?.removePrefix("Bearer ")
            ?: throw ApiException(401, "UNAUTHORIZED", "Bearer token required")
        return repository.findSession(sha256(token), OffsetDateTime.now(clock))
            ?: throw ApiException(401, "UNAUTHORIZED", "Session expired or invalid")
    }

    private fun issue(user: UserView, requestedDeviceId: String?): AuthView {
        if (requestedDeviceId != null && requestedDeviceId.length !in 1..64) {
            throw ApiException(400, "INVALID_DEVICE_ID", "deviceId must be 1 to 64 characters")
        }
        val deviceId = requestedDeviceId ?: UUID.randomUUID().toString()
        val bytes = ByteArray(32).also(random::nextBytes)
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        repository.insertSession(sha256(token), user.id, deviceId, OffsetDateTime.now(clock).plusDays(30))
        return AuthView(token, user, deviceId)
    }
}
