package com.andrewtinyakov.messenger.shared.web

import org.springframework.http.HttpStatus
import java.time.Duration

class ApiException(
    val status: HttpStatus,
    val code: ApiErrorCode,
    override val message: String,
    val retryAfter: Duration? = null,
    val errors: List<ApiFieldError> = emptyList(),
) : RuntimeException(message)

fun notFound(): Nothing =
    throw ApiException(
        HttpStatus.NOT_FOUND,
        ApiErrorCode.NOT_FOUND,
        "The requested resource was not found",
    )

fun notFound(message: String): Nothing =
    throw ApiException(HttpStatus.NOT_FOUND, ApiErrorCode.NOT_FOUND, message)

fun userNotFound(): Nothing = notFound("User not found")

fun conflict(code: ApiErrorCode, message: String): Nothing =
    throw ApiException(HttpStatus.CONFLICT, code, message)

fun invalidInput(field: String?, message: String): Nothing =
    throw ApiException(
        HttpStatus.BAD_REQUEST,
        ApiErrorCode.VALIDATION_FAILED,
        message,
        errors = listOfNotNull(field?.let { ApiFieldError(it, message) }),
    )

fun forbidden(message: String): Nothing =
    throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, message)

fun unauthorized(code: ApiErrorCode, message: String): Nothing =
    throw ApiException(HttpStatus.UNAUTHORIZED, code, message)

fun tooManyAttempts(retryAfter: Duration): Nothing =
    throw ApiException(HttpStatus.TOO_MANY_REQUESTS, ApiErrorCode.TOO_MANY_ATTEMPTS, "Too many attempts. Try again later.", retryAfter)
