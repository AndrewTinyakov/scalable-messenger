package com.andrewtinyakov.messenger.user.web.payload

import com.andrewtinyakov.messenger.user.model.User
import io.swagger.v3.oas.annotations.media.Schema

data class UserResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val username: String,
)

fun User.toResponse(): UserResponse = UserResponse(id, username)
