package com.andrewtinyakov.messenger.shared.web

import com.andrewtinyakov.messenger.shared.integration.DependencyUnavailableException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import java.time.Duration

class ApiExceptionHandlerTests {
    private val handler = ApiExceptionHandler()

    @Test
    fun `application error preserves status code and message`() {
        val response = handler.handle(ApiException(HttpStatus.CONFLICT, ApiErrorCode.USERNAME_TAKEN, "Username already exists"))
        val problem = response.body!!

        assertEquals(409, response.statusCode.value())
        assertEquals(409, problem.status)
        assertEquals("Username already exists", problem.detail)
        assertEquals("USERNAME_TAKEN", problem.properties?.get("code"))
        assertFalse(response.headers.containsHeader("Retry-After"))
    }

    @Test
    fun `validation error lists the invalid field`() {
        val exception = runCatching { invalidInput("name", "Group name must be 1 to 80 characters") }.exceptionOrNull() as ApiException
        val problem = handler.handle(exception).body!!

        assertEquals(400, problem.status)
        assertEquals("VALIDATION_FAILED", problem.properties?.get("code"))
        assertEquals(listOf(ApiFieldError("name", "Group name must be 1 to 80 characters")), problem.properties?.get("errors"))
    }

    @Test
    fun `rate limited error rounds its retry delay up to whole seconds`() {
        for ((delay, expected) in listOf(Duration.ofMillis(1) to "1", Duration.ofSeconds(4) to "4", Duration.ofMillis(4_001) to "5")) {
            val response = handler.handle(
                ApiException(HttpStatus.TOO_MANY_REQUESTS, ApiErrorCode.TOO_MANY_ATTEMPTS, "Too many attempts", delay),
            )

            assertEquals(429, response.statusCode.value())
            assertEquals(expected, response.headers.getFirst("Retry-After"))
            assertEquals("TOO_MANY_ATTEMPTS", response.body!!.properties?.get("code"))
        }
    }

    @Test
    fun `invalid input returns a stable client error`() {
        val problem = handler.handleInvalidInput(IllegalArgumentException("malformed input"))

        assertEquals(400, problem.status)
        assertEquals("VALIDATION_FAILED", problem.properties?.get("code"))
        assertFalse(problem.detail.orEmpty().contains("malformed input"))
    }

    @Test
    fun `dependency error hides transport details`() {
        val problem = handler.handle(DependencyUnavailableException("Redis", IllegalStateException("connection refused")))

        assertEquals(503, problem.status)
        assertEquals("SERVICE_UNAVAILABLE", problem.properties?.get("code"))
        assertFalse(problem.detail.orEmpty().contains("connection refused"))
    }

    @Test
    fun `unexpected error hides its message`() {
        val problem = handler.handleUnexpected(IllegalStateException("database password"))

        assertEquals(500, problem.status)
        assertEquals("INTERNAL_SERVER_ERROR", problem.properties?.get("code"))
        assertFalse(problem.detail.orEmpty().contains("database password"))
    }
}
