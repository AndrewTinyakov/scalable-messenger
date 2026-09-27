package com.andrewtinyakov.messenger.auth.model

data class UserAccount(
    val id: String,
    val username: String,
    val passwordHash: String,
)
