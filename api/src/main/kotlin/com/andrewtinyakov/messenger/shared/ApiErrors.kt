package com.andrewtinyakov.messenger.shared

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpStatus
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

class ApiException(
    val status: Int,
    val code: String,
    override val message: String,
) : RuntimeException(message)

@RestControllerAdvice
class ApiExceptionHandler {
    @ExceptionHandler(ApiException::class)
    fun api(error: ApiException): ResponseEntity<ProblemDetail> = problem(error.status, error.code, error.message)

    @ExceptionHandler(MethodArgumentNotValidException::class, HttpMessageNotReadableException::class, IllegalArgumentException::class)
    fun badInput(error: Exception): ResponseEntity<ProblemDetail> = problem(400, "INVALID_REQUEST", "Invalid request")

    @ExceptionHandler(Exception::class)
    fun unexpected(error: Exception, request: HttpServletRequest): ResponseEntity<ProblemDetail> {
        org.slf4j.LoggerFactory.getLogger(javaClass).error("Request failed: {}", request.requestURI, error)
        return problem(500, "INTERNAL_ERROR", "Internal server error")
    }

    private fun problem(status: Int, code: String, detail: String): ResponseEntity<ProblemDetail> {
        val value = ProblemDetail.forStatusAndDetail(HttpStatus.valueOf(status), detail)
        value.setProperty("code", code)
        return ResponseEntity.status(status).body(value)
    }
}
