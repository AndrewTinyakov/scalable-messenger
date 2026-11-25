package com.andrewtinyakov.messenger.shared.web

import com.andrewtinyakov.messenger.shared.integration.DependencyUnavailableException
import org.slf4j.LoggerFactory
import org.springframework.beans.TypeMismatchException
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.context.request.WebRequest
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler
import java.time.Duration

@RestControllerAdvice
class ApiExceptionHandler : ResponseEntityExceptionHandler() {
    private val logger = LoggerFactory.getLogger(javaClass)

    @ExceptionHandler(ApiException::class)
    fun handle(exception: ApiException): ResponseEntity<ProblemDetail> {
        val problem = problem(exception.status, exception.message, exception.code, exception.errors)
        val response = ResponseEntity.status(exception.status)
        exception.retryAfter?.let { response.header(HttpHeaders.RETRY_AFTER, it.retryAfterSeconds().toString()) }
        return response.body(problem)
    }

    @ExceptionHandler(IllegalArgumentException::class)
    fun handleInvalidInput(exception: Exception): ProblemDetail =
        problem(HttpStatus.BAD_REQUEST, "Invalid request", ApiErrorCode.VALIDATION_FAILED)

    @ExceptionHandler(DependencyUnavailableException::class)
    fun handle(exception: DependencyUnavailableException): ProblemDetail {
        logger.error("Dependency unavailable: {}", exception.dependency, exception)
        return problem(HttpStatus.SERVICE_UNAVAILABLE, "A required service is temporarily unavailable", ApiErrorCode.SERVICE_UNAVAILABLE)
    }

    @ExceptionHandler(Exception::class)
    fun handleUnexpected(exception: Exception): ProblemDetail {
        logger.error("Unhandled exception", exception)
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred", ApiErrorCode.INTERNAL_SERVER_ERROR)
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
            else -> ApiErrorCode.VALIDATION_FAILED
        }
        val detail = when (code) {
            ApiErrorCode.INTERNAL_SERVER_ERROR -> "An unexpected error occurred"
            ApiErrorCode.NOT_FOUND -> "The requested resource was not found"
            else -> "Invalid request"
        }
        if (statusCode.is5xxServerError) logger.error("Framework request processing failed", exception)
        val field = when (exception) {
            is MissingServletRequestParameterException -> exception.parameterName
            is TypeMismatchException -> exception.propertyName
            else -> null
        }
        val errors = listOfNotNull(field?.takeIf { code == ApiErrorCode.VALIDATION_FAILED }?.let { ApiFieldError(it, "$it is invalid") })
        val problem = problem(statusCode, detail, code, errors)
        return super.handleExceptionInternal(exception, problem, headers, statusCode, request)
    }

    private fun problem(
        status: HttpStatusCode,
        detail: String,
        code: ApiErrorCode,
        errors: List<ApiFieldError> = emptyList(),
    ): ProblemDetail = ProblemDetail.forStatusAndDetail(status, detail).apply {
        setProperty("code", code.name)
        if (errors.isNotEmpty()) setProperty("errors", errors)
    }
}

private fun Duration.retryAfterSeconds(): Long = maxOf(1, toSeconds() + if (toNanosPart() > 0) 1 else 0)
