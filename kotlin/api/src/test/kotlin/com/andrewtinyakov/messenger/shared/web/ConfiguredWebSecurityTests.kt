package com.andrewtinyakov.messenger.shared.web

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.test.context.SpringBootTest
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64

@SpringBootTest(
    classes = [ApiApplication::class],
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "messenger.grpc.enabled=false",
        "spring.rabbitmq.dynamic=false",
        "spring.rabbitmq.listener.simple.auto-startup=false",
        "spring.security.user.password=configured-monitoring-password",
        "messenger.web.cors.allowed-origins[0]=http://localhost:5173",
        "messenger.web.cors.allowed-origins[1]=http://localhost:5174",
        "messenger.web.cors.allowed-methods[0]=GET",
        "messenger.web.cors.allowed-methods[1]=POST",
        "messenger.web.cors.allowed-methods[2]=OPTIONS",
        "messenger.web.cors.allowed-headers[0]=Content-Type",
        "messenger.web.cors.allowed-headers[1]=X-Messenger-CSRF",
        "messenger.web.cors.allowed-headers[2]=X-Custom",
        "messenger.web.cors.allow-credentials=false",
        "messenger.web.security.public-paths[0]=/v1/observed/public",
        "messenger.web.security.monitoring-paths[0]=/v1/observed/**",
        "messenger.web.security.denied-paths[0]=/v1/blocked/**",
        "messenger.web.security.denied-paths[1]=/v1/observed/**",
        "messenger.web.security.denied-paths[2]=/actuator/**",
    ],
)
class ConfiguredWebSecurityTests : MessengerIntegrationTest() {
    @Value($$"${local.server.port}")
    private var port: Int = 0

    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val credentials = "Basic " + Base64.getEncoder().encodeToString("metrics:configured-monitoring-password".toByteArray())

    @Test
    fun `configured endpoint groups apply in their existing precedence`() {
        assertEquals(401, get("/api/v1/observed/private").statusCode())
        assertEquals(404, get("/api/v1/observed/private", credentials).statusCode())
        assertEquals(404, get("/api/v1/observed/public").statusCode())
        assertEquals(403, get("/api/v1/blocked/private", credentials).statusCode())
        assertEquals(403, get("/api/actuator/health", credentials).statusCode())
        assertEquals(404, get("/api/unknown").statusCode())
    }

    @Test
    fun `configured CORS origins methods headers and credentials govern preflight`() {
        for (origin in listOf("http://localhost:5173", "http://localhost:5174")) {
            val response = preflight(origin, "POST", "X-Custom,X-Messenger-CSRF")
            assertEquals(200, response.statusCode())
            assertEquals(origin, response.headers().firstValue("Access-Control-Allow-Origin").orElseThrow())
            assertFalse(response.headers().firstValue("Access-Control-Allow-Credentials").isPresent)
        }
        assertEquals(403, preflight("https://untrusted.example", "POST", "X-Custom").statusCode())
        assertEquals(403, preflight("http://localhost:5174", "DELETE", "X-Custom").statusCode())
        assertEquals(403, preflight("http://localhost:5174", "POST", "X-Disallowed").statusCode())
    }

    @Test
    fun `browser mutations accept each configured origin and still require the CSRF header`() {
        for (origin in listOf("http://localhost:5173", "http://localhost:5174")) {
            val request = builder("/api/v1/auth/login").header("Origin", origin)
                .header("Content-Type", "application/json").header("X-Messenger-CSRF", "1")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
            assertEquals(400, send(request).statusCode())
        }
        val missingCsrf = builder("/api/v1/auth/login").header("Origin", "http://localhost:5174")
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{}"))
        assertEquals(403, send(missingCsrf).statusCode())
    }

    private fun get(path: String, authorization: String? = null): HttpResponse<String> {
        val request = builder(path)
        authorization?.let { request.header("Authorization", it) }
        return send(request)
    }

    private fun preflight(origin: String, method: String, headers: String): HttpResponse<String> = send(
        builder("/api/v1/auth/login").header("Origin", origin)
            .header("Access-Control-Request-Method", method).header("Access-Control-Request-Headers", headers)
            .method("OPTIONS", HttpRequest.BodyPublishers.noBody()),
    )

    private fun builder(path: String): HttpRequest.Builder =
        HttpRequest.newBuilder(URI.create("http://localhost:$port$path")).timeout(Duration.ofSeconds(10))

    private fun send(request: HttpRequest.Builder): HttpResponse<String> =
        http.send(request.build(), HttpResponse.BodyHandlers.ofString())
}
