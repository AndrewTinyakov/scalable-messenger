package com.andrewtinyakov.messenger.auth.model

private val sessionIdPattern = Regex("[0-9a-f]{64}")

fun isValidSessionId(value: String): Boolean = sessionIdPattern.matches(value)

@JvmInline
value class SessionId(
    val value: String,
) {
    init {
        require(isValidSessionId(value)) { "Invalid session ID" }
    }
}
