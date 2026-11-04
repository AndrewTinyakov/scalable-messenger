package com.andrewtinyakov.messenger.auth.web.payload

import com.andrewtinyakov.messenger.user.web.payload.UserResponse
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size

data class AuthRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(min = 3, max = 40) val username: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(min = 8, max = 100) val password: String,
    val deviceId: String? = null,
)

data class AuthResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val token: String,
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
