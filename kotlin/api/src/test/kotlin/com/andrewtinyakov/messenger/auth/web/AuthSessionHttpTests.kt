package com.andrewtinyakov.messenger.auth.web

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.MeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.clearInvocations
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean
import org.testcontainers.containers.PostgreSQLContainer
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.OffsetDateTime
import java.util.Base64

private const val CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
private const val FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"
private const val CLIENT_ORIGIN = "http://localhost:5173"

@SpringBootTest(
    classes = [ApiApplication::class],
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "spring.security.user.password=test-monitoring-password",
        "messenger.auth.login-throttle.base-delay=10m",
        "messenger.web.cors.allowed-origins[0]=$CLIENT_ORIGIN",
        "messenger.grpc.enabled=false",
        "spring.rabbitmq.dynamic=false",
        "spring.rabbitmq.listener.simple.auto-startup=false",
    ],
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AuthSessionHttpTests {
    companion object {
        private val postgres = PostgreSQLContainer<Nothing>("postgres:17-alpine").apply {
            withDatabaseName("messenger")
            withUsername("messenger")
            withPassword("messenger")
            start()
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username", postgres::getUsername)
            registry.add("spring.datasource.password", postgres::getPassword)
        }
    }

    @Value($$"${local.server.port}")
    private var port: Int = 0

    @Autowired private lateinit var mapper: ObjectMapper

    @Autowired private lateinit var db: JdbcTemplate

    @Autowired private lateinit var metrics: MeterRegistry

    @MockitoSpyBean private lateinit var passwordEncoder: PasswordEncoder

    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val monitoring = "Basic " + Base64.getEncoder().encodeToString("metrics:test-monitoring-password".toByteArray())

    @BeforeEach
    fun forgetEncoderCalls() {
        clearInvocations(passwordEncoder)
    }

    @Test
    fun `database work is attributed to the matched route without per call names`() {
        val account = register()
        val route = {
            metrics.find("messenger.database.query").tags("entrypoint_kind", "route", "entrypoint", "GET /v1/auth/sessions").timers()
        }
        val before = route().sumOf { it.count() }
        assertEquals(200, send(authenticated(get("/api/v1/auth/sessions"), account)).statusCode())
        assertTrue(route().sumOf { it.count() } >= before + 2, "session lookup and listing both count toward the route")
    }

    @Test
    fun `basic credentials are checked only on monitoring paths and never with the password hasher`() {
        val account = register()
        clearInvocations(passwordEncoder)
        val wrong = "Basic " + Base64.getEncoder().encodeToString("metrics:wrong-password".toByteArray())
        val unknown = "Basic " + Base64.getEncoder().encodeToString("intruder:guess".toByteArray())

        for (header in listOf(monitoring, wrong, unknown)) {
            for (path in listOf("/api/v1/users?query=alice", "/api/v1/auth/session", "/api/v1/auth/sessions")) {
                val response = send(get(path).header("Authorization", header))
                assertEquals(401, response.statusCode(), "$path $header")
                assertEquals("UNAUTHORIZED", mapper.readTree(response.body()).path("code").stringValue())
                assertFalse(response.headers().firstValue("WWW-Authenticate").isPresent, "$path $header")
            }
            val withCookie = send(get("/api/v1/auth/session").header("Authorization", header).header("Cookie", account.cookie))
            assertEquals(200, withCookie.statusCode())
        }

        assertEquals(200, send(get("/api/actuator/prometheus").header("Authorization", monitoring)).statusCode())
        for (header in listOf(wrong, unknown)) {
            val rejected = send(get("/api/actuator/prometheus").header("Authorization", header))
            assertEquals(401, rejected.statusCode())
            assertTrue(rejected.headers().firstValue("WWW-Authenticate").orElse("").startsWith("Basic"))
        }
        verify(passwordEncoder, never()).matches(any(), anyString())
    }

    @Test
    fun `an authenticated request after a day of inactivity extends the session without re-sending the long-lived cookie`() {
        val username = "renew_${newId().lowercase().take(16)}"
        val issued = send(post("/api/v1/auth/register", credentials(username, "long-demo-password")))
        val header = issued.headers().firstValue("Set-Cookie").orElseThrow()
        assertTrue(header.contains("; Max-Age=${Duration.ofDays(400).seconds};"), header)
        val account = login(username = username)

        db.update(
            "UPDATE sessions SET last_used_at=now() - interval '2 days', expires_at=now() + interval '28 days' WHERE token_hash=?",
            account.sessionId,
        )
        val renewed = send(get("/api/v1/auth/session").header("Cookie", account.cookie))

        assertEquals(200, renewed.statusCode())
        assertFalse(renewed.headers().firstValue("Set-Cookie").isPresent)
        val expiresAt = db.queryForObject(
            "SELECT expires_at FROM sessions WHERE token_hash=?",
            OffsetDateTime::class.java,
            account.sessionId,
        )!!
        assertTrue(Duration.between(OffsetDateTime.now(), expiresAt) > Duration.ofDays(29))
    }

    @Test
    fun `sessions endpoint lists the caller's devices and marks the current one`() {
        val username = "devices_${newId().lowercase().take(16)}"
        val first = register(username = username, userAgent = CHROME_MAC)
        val second = login(username = username, userAgent = FIREFOX_WINDOWS)
        register()

        val response = send(authenticated(get("/api/v1/auth/sessions"), first))
        assertEquals(200, response.statusCode())
        val sessions = mapper.readTree(response.body()).path("sessions").toList()

        assertEquals(2, sessions.size)
        assertEquals(setOf("id", "deviceLabel", "createdAt", "lastUsedAt", "current"), sessions.first().propertyNames().toSet())
        val current = sessions.single { it.path("current").booleanValue() }
        assertEquals("Chrome on macOS", current.path("deviceLabel").stringValue())
        assertEquals("Firefox on Windows", sessions.single { !it.path("current").booleanValue() }.path("deviceLabel").stringValue())
        assertEquals(setOf(first.sessionId, second.sessionId), sessions.map { it.path("id").stringValue() }.toSet())
    }

    @Test
    fun `users cannot revoke another account's session through the API`() {
        val attacker = register()
        val victim = register()

        val missing = send(authenticated(delete("/api/v1/auth/sessions/${victim.sessionId}"), attacker))
        val malformed = send(authenticated(delete("/api/v1/auth/sessions/not-a-session"), attacker))

        assertEquals(404, missing.statusCode())
        assertEquals(404, malformed.statusCode())
        assertFalse(missing.headers().firstValue("Set-Cookie").isPresent)
        assertEquals(200, send(get("/api/v1/auth/session").header("Cookie", victim.cookie)).statusCode())
        assertEquals(200, send(get("/api/v1/auth/session").header("Cookie", attacker.cookie)).statusCode())
    }

    @Test
    fun `revoking the current session signs this browser out and revoking others keeps it`() {
        val username = "signout_${newId().lowercase().take(16)}"
        val current = register(username = username)
        val other = login(username = username)
        val third = login(username = username)

        val others = send(authenticated(post("/api/v1/auth/sessions/revoke-others"), current))
        assertEquals(200, others.statusCode())
        assertEquals(2, mapper.readTree(others.body()).path("revokedSessions").intValue())
        assertEquals(401, send(get("/api/v1/auth/session").header("Cookie", other.cookie)).statusCode())
        assertEquals(401, send(get("/api/v1/auth/session").header("Cookie", third.cookie)).statusCode())

        val self = send(authenticated(delete("/api/v1/auth/sessions/${current.sessionId}"), current))
        assertEquals(204, self.statusCode())
        assertTrue(self.headers().allValues("Set-Cookie").last().contains("Max-Age=0"))
        assertEquals(401, send(get("/api/v1/auth/session").header("Cookie", current.cookie)).statusCode())
    }

    @Test
    fun `password change requires the current password and rotates this browser token and signs out other devices`() {
        val username = "change_${newId().lowercase().take(16)}"
        val current = register(username = username)
        val other = login(username = username)

        val wrong = send(
            authenticated(
                post("/api/v1/auth/password", """{"currentPassword":"wrong-password","newPassword":"new-demo-password"}"""),
                current,
            ),
        )
        assertEquals(403, wrong.statusCode())
        assertEquals("INVALID_CREDENTIALS", mapper.readTree(wrong.body()).path("code").stringValue())
        val short =
            send(
                authenticated(post("/api/v1/auth/password", """{"currentPassword":"long-demo-password","newPassword":"short"}"""), current),
            )
        assertEquals(400, short.statusCode())

        val changed = send(
            authenticated(
                post("/api/v1/auth/password", """{"currentPassword":"long-demo-password","newPassword":"new-demo-password"}"""),
                current,
            ),
        )
        assertEquals(200, changed.statusCode())
        assertEquals(1, mapper.readTree(changed.body()).path("revokedSessions").intValue())
        val rotated = changed.headers().allValues("Set-Cookie").last().substringBefore(';')
        assertTrue(rotated != current.cookie && rotated.startsWith(current.cookie.substringBefore('=') + "="))
        assertEquals(200, send(get("/api/v1/auth/session").header("Cookie", rotated)).statusCode())
        assertEquals(200, send(get("/api/v1/auth/session").header("Cookie", current.cookie)).statusCode())
        val retiredUntil = db.queryForObject(
            "SELECT expires_at FROM sessions WHERE token_hash=?",
            OffsetDateTime::class.java,
            current.sessionId,
        )!!
        assertTrue(Duration.between(OffsetDateTime.now(), retiredUntil) <= Duration.ofSeconds(60))
        db.update("UPDATE sessions SET expires_at=now() - interval '1 minute' WHERE token_hash=?", current.sessionId)
        assertEquals(401, send(get("/api/v1/auth/session").header("Cookie", current.cookie)).statusCode())
        assertEquals(401, send(get("/api/v1/auth/session").header("Cookie", other.cookie)).statusCode())
        assertEquals(401, send(post("/api/v1/auth/login", credentials(username, "long-demo-password"))).statusCode())
        assertEquals(200, send(post("/api/v1/auth/login", credentials(username, "new-demo-password"))).statusCode())
    }

    @Test
    fun `locked and unknown accounts return the same rate limited response`() {
        val existing = "locked_${newId().lowercase().take(16)}"
        register(username = existing)
        val unknown = "nobody_${newId().lowercase().take(16)}"

        val bodies = listOf(existing, unknown).map { username ->
            val statuses = List(5) { send(post("/api/v1/auth/login", credentials(username, "wrong-password"))).statusCode() }
            assertEquals(List(5) { 401 }, statuses, username)
            val blocked = send(post("/api/v1/auth/login", credentials(username, "wrong-password")))
            assertEquals(429, blocked.statusCode(), username)
            assertTrue(blocked.headers().firstValue("Retry-After").orElseThrow().toLong() in 590..600)
            assertEquals(CLIENT_ORIGIN, blocked.headers().firstValue("Access-Control-Allow-Origin").orElseThrow())
            assertEquals("true", blocked.headers().firstValue("Access-Control-Allow-Credentials").orElseThrow())
            assertEquals("Retry-After", blocked.headers().firstValue("Access-Control-Expose-Headers").orElseThrow())
            mapper.readTree(blocked.body())
        }

        assertEquals(bodies[0], bodies[1])
        assertEquals("TOO_MANY_ATTEMPTS", bodies[0].path("code").stringValue())

        val request = post("/api/v1/auth/login", credentials(existing, "wrong-password"))
        val rejected = send(request.setHeader("Origin", "http://localhost:5174"))
        assertEquals(403, rejected.statusCode())
        assertFalse(rejected.headers().firstValue("Access-Control-Allow-Origin").isPresent)
        assertFalse(rejected.headers().firstValue("Access-Control-Expose-Headers").isPresent)
    }

    @Test
    fun `login backoff from one client address does not lock the account for other addresses`() {
        val username = "lockout_${newId().lowercase().take(16)}"
        register(username = username)

        fun attempt(address: String, password: String) =
            send(post("/api/v1/auth/login", credentials(username, password)).header("X-Forwarded-For", address)).statusCode()

        assertEquals(List(5) { 401 }, List(5) { attempt("203.0.113.5", "wrong-password") })
        assertEquals(429, attempt("203.0.113.5", "long-demo-password"))
        assertEquals(200, attempt("203.0.113.6", "long-demo-password"))
    }

    private fun register(username: String = "http_${newId().lowercase().take(20)}", userAgent: String? = null): AuthHttpAccount =
        authenticate("/api/v1/auth/register", username, userAgent, expectedStatus = 201)

    private fun login(username: String, userAgent: String? = null): AuthHttpAccount =
        authenticate("/api/v1/auth/login", username, userAgent, expectedStatus = 200)

    private fun authenticate(path: String, username: String, userAgent: String?, expectedStatus: Int): AuthHttpAccount {
        val request = post(path, credentials(username, "long-demo-password"))
        userAgent?.let { request.header("User-Agent", it) }
        val response = send(request)
        assertEquals(expectedStatus, response.statusCode(), response.body())
        val body: JsonNode = mapper.readTree(response.body())
        val cookie = response.headers().firstValue("Set-Cookie").orElseThrow().substringBefore(';')
        val token = cookie.substringAfter('=')
        return AuthHttpAccount(
            userId = body.path("user").path("id").stringValue(),
            cookie = cookie,
            deviceId = body.path("deviceId").stringValue(),
            sessionId = sha256(token),
        )
    }

    private fun credentials(username: String, password: String) = """{"username":"$username","password":"$password"}"""

    private fun authenticated(request: HttpRequest.Builder, account: AuthHttpAccount): HttpRequest.Builder =
        request.header("Cookie", account.cookie).header("X-Messenger-User", account.userId).header("X-Messenger-Device", account.deviceId)

    private fun get(path: String): HttpRequest.Builder = builder(path).GET()

    private fun delete(path: String): HttpRequest.Builder = browser(builder(path)).DELETE()

    private fun post(path: String, body: String = ""): HttpRequest.Builder =
        browser(builder(path)).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body))

    private fun browser(request: HttpRequest.Builder) = request.header("Origin", CLIENT_ORIGIN).header("X-Messenger-CSRF", "1")

    private fun builder(path: String): HttpRequest.Builder =
        HttpRequest.newBuilder(URI.create("http://localhost:$port$path")).timeout(Duration.ofSeconds(10))

    private fun send(request: HttpRequest.Builder): HttpResponse<String> = http.send(request.build(), HttpResponse.BodyHandlers.ofString())
}
