package com.andrewtinyakov.messenger.shared.web

import org.springframework.http.HttpStatus

class ApiException(
    val status: HttpStatus,
    val code: ApiErrorCode,
    override val message: String,
) : RuntimeException(message)

fun notFound(): Nothing =
    throw ApiException(
        HttpStatus.NOT_FOUND,
        ApiErrorCode.NOT_FOUND,
        "The requested resource was not found",
    )

fun notFound(code: ApiErrorCode, message: String): Nothing =
    throw ApiException(HttpStatus.NOT_FOUND, code, message)

fun userNotFound(): Nothing = notFound(ApiErrorCode.USER_NOT_FOUND, "User not found")

fun conflict(code: ApiErrorCode, message: String): Nothing =
    throw ApiException(HttpStatus.CONFLICT, code, message)

fun badRequest(code: ApiErrorCode, message: String): Nothing =
    throw ApiException(HttpStatus.BAD_REQUEST, code, message)

fun forbidden(message: String): Nothing =
    throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, message)

fun unauthorized(code: ApiErrorCode, message: String): Nothing =
    throw ApiException(HttpStatus.UNAUTHORIZED, code, message)
