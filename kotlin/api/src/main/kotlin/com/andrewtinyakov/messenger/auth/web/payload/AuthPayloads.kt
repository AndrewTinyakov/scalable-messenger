package com.andrewtinyakov.messenger.auth.web.payload

import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.SessionSummary
import com.andrewtinyakov.messenger.auth.model.User
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.OffsetDateTime
import java.time.ZoneOffset

data class AuthRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(min = User.MIN_USERNAME_LENGTH, max = User.MAX_USERNAME_LENGTH) val username: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(min = User.MIN_PASSWORD_LENGTH, max = User.MAX_PASSWORD_LENGTH) val password: String,
    val deviceId: String? = null,
)

data class AuthResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val user: UserResponse,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deviceId: String,
)

data class SessionResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val userId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val username: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deviceId: String,
)

data class ChangePasswordRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(max = User.MAX_PASSWORD_LENGTH) val currentPassword: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(min = User.MIN_PASSWORD_LENGTH, max = User.MAX_PASSWORD_LENGTH) val newPassword: String,
)

data class ActiveSessionResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deviceLabel: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val createdAt: OffsetDateTime,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val lastUsedAt: OffsetDateTime,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val current: Boolean,
)

data class ActiveSessionsResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val sessions: List<ActiveSessionResponse>,
)

data class RevokedSessionsResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val revokedSessions: Int,
)

fun SessionCredentials.toAuthResponse(): AuthResponse = AuthResponse(
    user = UserResponse(id = user.id.value, username = user.username),
    deviceId = session.deviceId.value,
)

fun SessionSummary.toResponse(currentSessionId: SessionId): ActiveSessionResponse = ActiveSessionResponse(
    id = sessionId.value,
    deviceLabel = deviceLabel.value,
    createdAt = createdAt.atOffset(ZoneOffset.UTC),
    lastUsedAt = lastUsedAt.atOffset(ZoneOffset.UTC),
    current = sessionId == currentSessionId,
)
