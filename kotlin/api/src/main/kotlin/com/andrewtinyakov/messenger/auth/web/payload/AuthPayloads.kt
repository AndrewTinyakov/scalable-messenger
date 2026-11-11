package com.andrewtinyakov.messenger.auth.web.payload

import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.auth.model.User
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size

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

data class WsTicketResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val token: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val expiresAt: Long,
)

fun SessionCredentials.toAuthResponse(): AuthResponse = AuthResponse(
    user = UserResponse(id = user.id.value, username = user.username),
    deviceId = session.deviceId.value,
)
