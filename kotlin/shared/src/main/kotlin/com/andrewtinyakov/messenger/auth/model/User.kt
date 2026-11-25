package com.andrewtinyakov.messenger.auth.model

private val usernamePattern = Regex("[a-z0-9_]{${User.MIN_USERNAME_LENGTH},${User.MAX_USERNAME_LENGTH}}")

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

        fun isValidUsername(username: String): Boolean = usernamePattern.matches(username)

        fun isValidPassword(password: String): Boolean =
            password.length in MIN_PASSWORD_LENGTH..MAX_PASSWORD_LENGTH && password.isNotBlank()
    }
}
