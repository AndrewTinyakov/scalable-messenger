package com.andrewtinyakov.messenger.auth.web.payload

import com.andrewtinyakov.messenger.auth.model.UserSummary
import io.swagger.v3.oas.annotations.media.Schema

data class UserResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val username: String,
)

fun UserSummary.toResponse(): UserResponse = UserResponse(id = id.value, username = username)
