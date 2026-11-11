package com.andrewtinyakov.messenger.auth.model

private val sessionTokenPattern = Regex("[A-Za-z0-9_-]{43}")

fun isValidSessionToken(value: String): Boolean = sessionTokenPattern.matches(value)

@JvmInline
value class SessionToken(
    val value: String,
) {
    init {
        require(isValidSessionToken(value)) { "Invalid session token" }
    }
}
