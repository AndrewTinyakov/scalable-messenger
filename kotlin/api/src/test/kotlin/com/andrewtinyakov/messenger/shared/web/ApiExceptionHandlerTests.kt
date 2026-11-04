package com.andrewtinyakov.messenger.shared.web

import com.andrewtinyakov.messenger.shared.integration.DependencyUnavailableException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus

class ApiExceptionHandlerTests {
    private val handler = ApiExceptionHandler()

    @Test
    fun `application error preserves status code and message`() {
        val problem = handler.handle(ApiException(HttpStatus.CONFLICT, ApiErrorCode.USERNAME_TAKEN, "Username already exists"))

        assertEquals(409, problem.status)
        assertEquals("Username already exists", problem.detail)
        assertEquals("USERNAME_TAKEN", problem.properties?.get("code"))
    }

    @Test
    fun `invalid input returns a stable client error`() {
        val problem = handler.handleInvalidInput(IllegalArgumentException("malformed input"))

        assertEquals(400, problem.status)
        assertEquals("INVALID_REQUEST", problem.properties?.get("code"))
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
