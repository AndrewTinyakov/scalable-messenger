package com.andrewtinyakov.messenger.auth.model

data class User(
    val id: UserId,
    val username: String,
    val passwordHash: String,
)
