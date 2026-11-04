package com.andrewtinyakov.messenger.shared.id

import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.github.f4b6a3.ulid.UlidCreator

private val ulidPattern = Regex("[0-7][0-9A-HJKMNP-TV-Z]{25}")
private val sessionIdPattern = Regex("[0-9a-f]{64}")
private val sessionTokenPattern = Regex("[A-Za-z0-9_-]{43}")

fun newId(): String = UlidCreator.getUlid().toString()

fun requireId(value: String): String {
    if (!isValidId(value)) badRequest(ApiErrorCode.INVALID_ID, "Invalid ULID")
    return value
}

fun isValidId(value: String): Boolean = ulidPattern.matches(value)

fun isValidSessionId(value: String): Boolean = sessionIdPattern.matches(value)

fun isValidSessionToken(value: String): Boolean = sessionTokenPattern.matches(value)

@JvmInline
value class UserId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid user ID" }
    }

    companion object {
        fun parse(value: String) = UserId(requireId(value))
    }
}

@JvmInline
value class ChatId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid chat ID" }
    }

    companion object {
        fun parse(value: String) = ChatId(requireId(value))
    }
}

@JvmInline
value class RequestId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid request ID" }
    }
}

@JvmInline
value class MessageId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid message ID" }
    }

    companion object {
        fun parse(value: String) = MessageId(requireId(value))
    }
}

@JvmInline
value class EventId(
    val value: String,
) {
    init {
        require(isValidId(value)) { "Invalid event ID" }
    }
}

@JvmInline
value class SessionId(
    val value: String,
) {
    init {
        require(isValidSessionId(value)) { "Invalid session ID" }
    }
}

@JvmInline
value class DeviceId(
    val value: String,
) {
    init {
        require(value.isNotBlank() && value.length <= 64) { "Invalid device ID" }
    }
}

@JvmInline
value class SessionToken(
    val value: String,
) {
    init {
        require(isValidSessionToken(value)) { "Invalid session token" }
    }
}
