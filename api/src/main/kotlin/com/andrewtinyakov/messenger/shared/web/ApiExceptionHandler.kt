package com.andrewtinyakov.messenger.shared.web

import com.andrewtinyakov.messenger.shared.integration.DependencyUnavailableException
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.ProblemDetail
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

@RestControllerAdvice
class ApiExceptionHandler {
    private val logger = LoggerFactory.getLogger(javaClass)

    @ExceptionHandler(ApiException::class)
    fun handle(exception: ApiException): ProblemDetail =
        ProblemDetail.forStatusAndDetail(exception.status, exception.message).apply {
            setProperty("code", exception.code.value)
        }

    @ExceptionHandler(MethodArgumentNotValidException::class, HttpMessageNotReadableException::class, IllegalArgumentException::class)
    fun handleInvalidInput(exception: Exception): ProblemDetail =
        ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid request").apply {
            setProperty("code", ApiErrorCode.INVALID_REQUEST.value)
        }

    @ExceptionHandler(DependencyUnavailableException::class)
    fun handle(exception: DependencyUnavailableException): ProblemDetail {
        logger.error("Dependency unavailable: {}", exception.dependency, exception)
        return ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, "A required service is temporarily unavailable").apply {
            setProperty("code", ApiErrorCode.SERVICE_UNAVAILABLE.value)
        }
    }

    @ExceptionHandler(Exception::class)
    fun handleUnexpected(exception: Exception): ProblemDetail {
        logger.error("Unhandled exception", exception)
        return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred").apply {
            setProperty("code", ApiErrorCode.INTERNAL_SERVER_ERROR.value)
        }
    }
}
