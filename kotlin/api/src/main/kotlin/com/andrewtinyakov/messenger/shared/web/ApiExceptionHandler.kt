package com.andrewtinyakov.messenger.shared.web

import com.andrewtinyakov.messenger.shared.integration.DependencyUnavailableException
import org.slf4j.LoggerFactory
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.context.request.WebRequest
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler

@RestControllerAdvice
class ApiExceptionHandler : ResponseEntityExceptionHandler() {
    private val logger = LoggerFactory.getLogger(javaClass)

    @ExceptionHandler(ApiException::class)
    fun handle(exception: ApiException): ProblemDetail =
        ProblemDetail.forStatusAndDetail(exception.status, exception.message).apply {
            setProperty("code", exception.code.value)
        }

    @ExceptionHandler(IllegalArgumentException::class)
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

    override fun handleExceptionInternal(
        exception: Exception,
        body: Any?,
        headers: HttpHeaders,
        statusCode: HttpStatusCode,
        request: WebRequest,
    ): ResponseEntity<Any>? {
        val code = when {
            statusCode.is5xxServerError -> ApiErrorCode.INTERNAL_SERVER_ERROR
            statusCode.value() == HttpStatus.NOT_FOUND.value() -> ApiErrorCode.NOT_FOUND
            else -> ApiErrorCode.INVALID_REQUEST
        }
        val detail = when (code) {
            ApiErrorCode.INTERNAL_SERVER_ERROR -> "An unexpected error occurred"
            ApiErrorCode.NOT_FOUND -> "The requested resource was not found"
            else -> "Invalid request"
        }
        if (statusCode.is5xxServerError) logger.error("Framework request processing failed", exception)
        val problem = ProblemDetail.forStatusAndDetail(statusCode, detail).apply { setProperty("code", code.value) }
        return super.handleExceptionInternal(exception, problem, headers, statusCode, request)
    }
}
