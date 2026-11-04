package com.andrewtinyakov.messenger.auth.model

import com.andrewtinyakov.messenger.shared.id.UserId

data class User(
    val id: UserId,
    val username: String,
    val passwordHash: String,
)
