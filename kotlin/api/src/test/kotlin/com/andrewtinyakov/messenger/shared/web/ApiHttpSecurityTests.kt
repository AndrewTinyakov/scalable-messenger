package com.andrewtinyakov.messenger.shared.web

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.shared.id.SessionToken
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import tools.jackson.databind.ObjectMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.UUID

@SpringBootTest(
    classes = [ApiApplication::class],
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "spring.security.user.password=test-monitoring-password",
        "messenger.grpc.enabled=false", "spring.rabbitmq.dynamic=false",
        "spring.rabbitmq.listener.simple.auto-startup=false",
    ],
)
class ApiHttpSecurityTests
    @Autowired
    constructor(
        @Value("\${local.server.port}") private val port: Int,
        private val mapper: ObjectMapper,
        private val authenticationService: AuthenticationService,
        private val db: JdbcTemplate,
    ) {
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

        private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

        @Test
        fun `duplicate registration returns conflict without changing the existing account or session`() {
            val username = "taken_${UUID.randomUUID().toString().replace("-", "").take(16)}"
            val created = mutate("/api/v1/auth/register", """{"username":"$username","password":"original-password"}""")
            assertEquals(201, created.statusCode())
            val userId = mapper.readTree(created.body()).path("user").path("id").stringValue()
            val cookie = created.headers().firstValue("Set-Cookie").orElseThrow().substringBefore(';')

            for (duplicate in listOf(username, " ${username.uppercase()} ")) {
                val response = mutate("/api/v1/auth/register", """{"username":"$duplicate","password":"different-password"}""")
                assertEquals(409, response.statusCode())
                val problem = mapper.readTree(response.body())
                assertEquals("USERNAME_TAKEN", problem.path("code").stringValue())
                assertEquals("Username already exists", problem.path("detail").stringValue())
                assertFalse(response.headers().firstValue("Set-Cookie").isPresent)
            }

            assertEquals(1, db.queryForObject("SELECT count(*) FROM users WHERE username=?", Int::class.java, username))
            assertEquals(1, db.queryForObject("SELECT count(*) FROM sessions WHERE user_id=?", Int::class.java, userId))
            assertEquals(200, request("/api/v1/auth/session", cookie).statusCode())
            assertEquals(200, mutate("/api/v1/auth/login", """{"username":"$username","password":"original-password"}""").statusCode())
            assertEquals(401, mutate("/api/v1/auth/login", """{"username":"$username","password":"different-password"}""").statusCode())
        }

        @Test
        fun `malformed typed IDs retain the invalid ID response`() {
            val cookie = bearer()
            for (path in listOf("/api/v1/chats/invalid", "/api/v1/chats/invalid/messages", "/api/v1/sends/invalid")) {
                val response = request(path, cookie)
                assertEquals(400, response.statusCode())
                assertEquals("INVALID_ID", mapper.readTree(response.body()).path("code").stringValue())
            }
        }

        @Test
        fun `unknown send lookup uses the uppercase response enum`() {
            val response = request("/api/v1/sends/${newId()}", bearer())
            assertEquals(200, response.statusCode())
            assertEquals("UNKNOWN", mapper.readTree(response.body()).path("status").stringValue())
        }

        @Test
        fun `authentication rejects duplicate JSON fields`() {
            val request = HttpRequest.newBuilder(URI.create("http://localhost:$port/api/v1/auth/login"))
                .header("Content-Type", "application/json")
                .header("Origin", "http://localhost:5173")
                .header("X-Messenger-CSRF", "1")
                .POST(HttpRequest.BodyPublishers.ofString("""{"username":"alice","username":"bob","password":"long-demo-password"}"""))
                .timeout(Duration.ofSeconds(10))
                .build()

            val response = http.send(request, HttpResponse.BodyHandlers.ofString())

            assertEquals(400, response.statusCode())
            assertEquals("INVALID_REQUEST", mapper.readTree(response.body()).path("code").stringValue())
        }

        @Test
        fun `invalid query parameter returns a client error`() {
            val response = request("/api/v1/chats?limit=invalid", bearer())

            assertEquals(400, response.statusCode())
            assertEquals("INVALID_REQUEST", mapper.readTree(response.body()).path("code").stringValue())
        }

        @Test
        fun `unknown route remains not found`() {
            assertEquals(404, request("/api/v1/unknown-route").statusCode())
        }

        @Test
        fun `unsupported method remains a client error`() {
            val response = request("/api/v1/auth/login")

            assertEquals(405, response.statusCode())
            assertEquals("POST", response.headers().firstValue("Allow").orElse(""))
        }

        @Test
        fun `monitoring credentials do not establish a browser session or application identity`() {
            val credentials = Base64.getEncoder().encodeToString("metrics:test-monitoring-password".toByteArray())
            val metrics = request("/api/actuator/prometheus", "Basic $credentials")
            val chats = request("/api/v1/chats", "Basic $credentials")

            assertEquals(200, metrics.statusCode())
            assertFalse(metrics.headers().firstValue("Set-Cookie").isPresent)
            assertEquals(401, chats.statusCode())
        }

        @Test
        fun `monitoring requires credentials`() {
            val response = request("/api/actuator/prometheus")

            assertEquals(401, response.statusCode())
            assertFalse(response.headers().firstValue("Set-Cookie").isPresent)
        }

        @Test
        fun `openapi remains public and does not expose the session request attribute`() {
            val response = request("/api/v3/api-docs")

            assertEquals(200, response.statusCode())
            val parameters = mapper.readTree(response.body()).path("paths").path("/v1/chats").path("get").path("parameters")
            assertFalse(parameters.any { it.path("name").stringValue() == "authenticatedSession" })
        }

        @Test
        fun `all mapped application routes validate a cookie session before invocation`() {
            val path = "/api/v1/users?query=alice"
            val bearer = bearer()
            val credentials = Base64.getEncoder().encodeToString("metrics:test-monitoring-password".toByteArray())

            assertEquals(401, request(path).statusCode())
            assertEquals(401, request(path, "Basic $credentials").statusCode())
            assertEquals(200, request(path, bearer).statusCode())

            authenticationService.logout(SessionToken(bearer.substringAfter("=")))
            val revoked = request(path, bearer)
            assertEquals(401, revoked.statusCode())
            assertEquals("UNAUTHORIZED", mapper.readTree(revoked.body()).path("code").stringValue())
        }

        @Test
        fun `registration issues only a secure host cookie and login restores identity`() {
            val username = "cookie_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val body = """{"username":"$username","password":"long-demo-password","deviceId":"cookie-device"}"""
            val created = mutate("/api/v1/auth/register", body)
            assertEquals(201, created.statusCode())
            val registered = mapper.readTree(created.body())
            assertEquals(setOf("user", "deviceId"), registered.propertyNames().toSet())
            assertEquals(setOf("id", "username"), registered.path("user").propertyNames().toSet())
            assertEquals(username, registered.path("user").path("username").stringValue())
            assertEquals("cookie-device", registered.path("deviceId").stringValue())
            val header = created.headers().firstValue("Set-Cookie").orElseThrow()
            assertTrue(header.contains("HttpOnly"))
            assertTrue(header.contains("Secure"))
            assertTrue(header.contains("SameSite=Strict"))
            assertTrue(header.contains("Path=/api"))
            assertTrue(header.contains("Max-Age="))
            assertFalse(header.contains("Domain="))
            val cookie = header.substringBefore(';')
            val session = mapper.readTree(request("/api/v1/auth/session", cookie).body())
            assertEquals(setOf("userId", "username", "deviceId"), session.propertyNames().toSet())
            assertEquals(username, session.path("username").stringValue())
            val login = mutate("/api/v1/auth/login", body)
            assertEquals(200, login.statusCode())
            assertEquals(registered, mapper.readTree(login.body()))
            val search = request("/api/v1/users?query=$username", cookie)
            assertEquals(200, search.statusCode())
            assertEquals(listOf(registered.path("user")), mapper.readTree(search.body()).toList())
            assertTrue(login.headers().firstValue("Set-Cookie").isPresent)
            assertEquals(401, request("/api/v1/auth/session", "Bearer ${cookie.substringAfter('=')}").statusCode())
        }

        @Test
        fun `session cookies reject duplicates and malformed values`() {
            val cookie = bearer()
            assertEquals(401, request("/api/v1/auth/session", "$cookie; $cookie").statusCode())
            assertEquals(401, request("/api/v1/auth/session", "messenger_session=invalid").statusCode())
            assertEquals(401, mutate("/api/v1/auth/logout", cookie = "$cookie; $cookie").statusCode())
        }

        @Test
        fun `unsafe requests require one trusted origin and one browser header`() {
            val cookie = bearer()
            assertEquals(403, mutate("/api/v1/auth/logout", cookie = cookie, origin = null).statusCode())
            assertEquals(403, mutate("/api/v1/auth/logout", cookie = cookie, csrf = null).statusCode())
            assertEquals(403, mutate("/api/v1/auth/logout", cookie = cookie, origin = "http://localhost:evil").statusCode())
            assertEquals(403, mutate("/api/v1/auth/login", "{}", origin = "null").statusCode())
            val duplicateOrigin = builder("/api/v1/auth/logout").header("Cookie", cookie)
                .header("Origin", "http://localhost:5173").header("Origin", "http://localhost:5173")
                .header("X-Messenger-CSRF", "1").POST(HttpRequest.BodyPublishers.noBody()).build()
            assertEquals(403, http.send(duplicateOrigin, HttpResponse.BodyHandlers.ofString()).statusCode())
            val duplicateCsrf = builder("/api/v1/auth/logout").header("Cookie", cookie)
                .header("Origin", "http://localhost:5173").header("X-Messenger-CSRF", "1").header("X-Messenger-CSRF", "1")
                .POST(HttpRequest.BodyPublishers.noBody()).build()
            assertEquals(403, http.send(duplicateCsrf, HttpResponse.BodyHandlers.ofString()).statusCode())
            assertEquals(200, request("/api/v1/auth/session", cookie).statusCode())
        }

        @Test
        fun `credentialed preflight permits only the trusted origin`() {
            val allowed = builder("/api/v1/auth/ws-ticket").header("Origin", "http://localhost:5173")
                .header(
                    "Access-Control-Request-Method",
                    "POST",
                ).header("Access-Control-Request-Headers", "X-Messenger-CSRF,X-Messenger-User")
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build()
            val response = http.send(allowed, HttpResponse.BodyHandlers.ofString())
            assertEquals(200, response.statusCode())
            assertEquals("true", response.headers().firstValue("Access-Control-Allow-Credentials").orElseThrow())
            assertEquals("http://localhost:5173", response.headers().firstValue("Access-Control-Allow-Origin").orElseThrow())
            val denied = builder("/api/v1/auth/ws-ticket").header("Origin", "https://attacker.example")
                .header("Access-Control-Request-Method", "POST").method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build()
            assertEquals(403, http.send(denied, HttpResponse.BodyHandlers.ofString()).statusCode())
        }

        @Test
        fun `logout revokes the cookie and expires it even when already absent`() {
            val cookie = bearer()
            val loggedOut = mutate("/api/v1/auth/logout", cookie = cookie)
            assertEquals(204, loggedOut.statusCode())
            assertTrue(loggedOut.headers().firstValue("Set-Cookie").orElseThrow().contains("Max-Age=0"))
            assertEquals(401, request("/api/v1/auth/session", cookie).statusCode())
            assertEquals(204, mutate("/api/v1/auth/logout", cookie = cookie).statusCode())
            assertEquals(204, mutate("/api/v1/auth/logout").statusCode())
        }

        @Test
        fun `stale tab identity cannot read or sign out a replacement cookie session`() {
            val cookie = bearer()
            val session = mapper.readTree(request("/api/v1/auth/session", cookie).body())
            val mismatched = builder("/api/v1/auth/session").header("Cookie", cookie).header("X-Messenger-User", "stale-user")
                .header("X-Messenger-Device", session.path("deviceId").stringValue()).build()
            assertEquals(401, http.send(mismatched, HttpResponse.BodyHandlers.ofString()).statusCode())
            val logout = builder("/api/v1/auth/logout").header("Cookie", cookie).header("X-Messenger-User", "stale-user")
                .header("X-Messenger-Device", session.path("deviceId").stringValue()).header("Origin", "http://localhost:5173")
                .header("X-Messenger-CSRF", "1").POST(HttpRequest.BodyPublishers.noBody()).build()
            val response = http.send(logout, HttpResponse.BodyHandlers.ofString())
            assertEquals(401, response.statusCode())
            assertFalse(response.headers().firstValue("Set-Cookie").isPresent)
            assertEquals(200, request("/api/v1/auth/session", cookie).statusCode())
            val ticket = builder("/api/v1/auth/ws-ticket").header("Cookie", cookie)
                .header(
                    "X-Messenger-User",
                    session.path("userId").stringValue(),
                ).header("X-Messenger-Device", session.path("deviceId").stringValue())
                .header("Origin", "http://localhost:5173").header("X-Messenger-CSRF", "1")
                .POST(HttpRequest.BodyPublishers.noBody()).build()
            assertEquals(200, http.send(ticket, HttpResponse.BodyHandlers.ofString()).statusCode())
        }

        @Test
        fun `logout validates every expected identity header without revoking on mismatch`() {
            val cookie = bearer()
            val session = mapper.readTree(request("/api/v1/auth/session", cookie).body())
            val user = session.path("userId").stringValue()
            val device = session.path("deviceId").stringValue()
            val rejected = listOf(
                listOf("X-Messenger-User" to user),
                listOf("X-Messenger-Device" to device),
                listOf("X-Messenger-User" to "", "X-Messenger-Device" to device),
                listOf("X-Messenger-User" to user, "X-Messenger-Device" to ""),
                listOf("X-Messenger-User" to "stale-user", "X-Messenger-Device" to device),
                listOf("X-Messenger-User" to user, "X-Messenger-Device" to "stale-device"),
                listOf("X-Messenger-User" to user, "X-Messenger-User" to user, "X-Messenger-Device" to device),
                listOf("X-Messenger-User" to user, "X-Messenger-Device" to device, "X-Messenger-Device" to device),
                listOf("X-Messenger-User" to "$user,$user", "X-Messenger-Device" to device),
            )
            for (headers in rejected) {
                val logout = logout(cookie = cookie, headers = headers)
                assertEquals(401, logout.statusCode(), headers.toString())
                assertEquals("UNAUTHORIZED", mapper.readTree(logout.body()).path("code").stringValue())
                assertFalse(logout.headers().firstValue("Set-Cookie").isPresent)
                assertEquals(200, request("/api/v1/auth/session", cookie).statusCode())
            }
            val loggedOut = logout(cookie = cookie, headers = listOf("X-Messenger-User" to user, "X-Messenger-Device" to device))
            assertEquals(204, loggedOut.statusCode())
            assertTrue(loggedOut.headers().firstValue("Set-Cookie").orElseThrow().contains("Max-Age=0"))
            assertEquals(401, request("/api/v1/auth/session", cookie).statusCode())
        }

        @Test
        fun `logout remains idempotent with stale headers when cookie is missing or unknown`() {
            val headers = listOf("X-Messenger-User" to "", "X-Messenger-User" to "stale-user")
            for (cookie in listOf(null, "messenger_session=${"A".repeat(43)}")) {
                val response = logout(cookie = cookie, headers = headers)
                assertEquals(204, response.statusCode())
                assertTrue(response.headers().firstValue("Set-Cookie").orElseThrow().contains("Max-Age=0"))
            }
        }

        @Test
        fun `session response reads the current username while session validation keeps persisted identity`() {
            val cookie = bearer()
            val before = mapper.readTree(request("/api/v1/auth/session", cookie).body())
            val username = "renamed_${newId().lowercase()}"
            db.update("UPDATE users SET username=? WHERE id=?", username, before.path("userId").stringValue())

            val response = request("/api/v1/auth/session", cookie)
            val session = mapper.readTree(response.body())
            assertEquals(200, response.statusCode())
            assertEquals(username, session.path("username").stringValue())
            assertEquals(before.path("userId"), session.path("userId"))
            assertEquals(before.path("deviceId"), session.path("deviceId"))
        }

        @Test
        fun `expired cookie logout ignores stale identity and clears the cookie`() {
            val cookie = bearer()
            val session = authenticationService.authenticatedSession(token = SessionToken(cookie.substringAfter('=')))
            db.update(
                "UPDATE sessions SET expires_at=? WHERE token_hash=?",
                java.time.OffsetDateTime.now().minusSeconds(1),
                session.sessionId.value,
            )

            val response = logout(cookie = cookie, headers = listOf("X-Messenger-User" to "stale-user"))

            assertEquals(204, response.statusCode())
            assertTrue(response.headers().firstValue("Set-Cookie").orElseThrow().contains("Max-Age=0"))
            assertEquals(401, request("/api/v1/auth/session", cookie).statusCode())
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='session_revoked' AND payload->>'sessionId'=?",
                    Int::class.java,
                    session.sessionId.value,
                ),
            )
        }

        private fun logout(cookie: String?, headers: List<Pair<String, String>>): HttpResponse<String> {
            val request = builder("/api/v1/auth/logout")
                .header("Origin", "http://localhost:5173")
                .header("X-Messenger-CSRF", "1")
            cookie?.let { request.header("Cookie", it) }
            headers.forEach { (name, value) -> request.header(name, value) }
            return http.send(request.POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString())
        }

        private fun builder(path: String): HttpRequest.Builder =
            HttpRequest.newBuilder(URI.create("http://localhost:$port$path")).timeout(Duration.ofSeconds(10))

        private fun mutate(
            path: String,
            body: String = "",
            cookie: String? = null,
            origin: String? = "http://localhost:5173",
            csrf: String? = "1",
        ): HttpResponse<String> {
            val request = builder(path).header("Content-Type", "application/json")
            cookie?.let { request.header("Cookie", it) }
            origin?.let { request.header("Origin", it) }
            csrf?.let { request.header("X-Messenger-CSRF", it) }
            return http.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString())
        }

        private fun bearer(): String {
            val username = "http_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            return "messenger_session=${authenticationService.register(AuthRequest(username, "long-demo-password")).token.value}"
        }

        private fun request(path: String, authorization: String? = null): HttpResponse<String> {
            val request = HttpRequest.newBuilder(URI.create("http://localhost:$port$path"))
                .timeout(Duration.ofSeconds(10))
            if (authorization !=
                null
            ) {
                request.header(if (authorization.startsWith("messenger_session=")) "Cookie" else "Authorization", authorization)
            }
            return http.send(request.build(), HttpResponse.BodyHandlers.ofString())
        }
    }
