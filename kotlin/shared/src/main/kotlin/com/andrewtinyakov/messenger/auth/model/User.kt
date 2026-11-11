package com.andrewtinyakov.messenger.auth.model

data class User(
    val id: UserId,
    val username: String,
    val passwordHash: String,
) {
    companion object {
        const val MIN_USERNAME_LENGTH = 3
        const val MAX_USERNAME_LENGTH = 40
        const val MIN_PASSWORD_LENGTH = 8
        const val MAX_PASSWORD_LENGTH = 100
    }
}
