package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.test.context.SpringBootTest
import tools.jackson.databind.ObjectMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

@SpringBootTest(
    classes = [ApiApplication::class],
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = ["messenger.grpc.enabled=false", "spring.rabbitmq.dynamic=false", "spring.rabbitmq.listener.simple.auto-startup=false"],
)
class UserLookupHttpTests
    @Autowired
    constructor(
        @Value("\${local.server.port}") private val port: Int,
        private val authenticationService: AuthenticationService,
        private val chatService: ChatService,
        private val membershipService: ChatMembershipService,
        private val mapper: ObjectMapper,
    ) : MessengerIntegrationTest() {
        private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

        @Test
        fun `authenticated users can look up themselves and unrelated users`() {
            val viewer = account()
            val username = "unrelated_${newId()}"
            val target = user(username)

            assertUser(target, username, viewer.second)
            assertUser(viewer.first, viewer.third, viewer.second)
        }

        @Test
        fun `a removed group member remains available by user ID`() {
            val owner = account()
            val username = "removed_${newId()}"
            val member = user(username)
            val chat = chatService.createGroup(UserId(owner.first), CreateGroupChatRequest("Lookup", listOf(member)))

            membershipService.removeMember(ChatId(chat.id), UserId(owner.first), UserId(member))

            assertUser(member, username, owner.second)
        }

        @Test
        fun `missing and malformed user IDs return distinct client errors`() {
            val viewer = account()
            for ((id, status, code) in listOf(
                Triple(newId(), 404, "USER_NOT_FOUND"),
                Triple("invalid", 400, "INVALID_ID"),
                Triple(newId().lowercase(), 400, "INVALID_ID"),
            )) {
                val response = get(id, viewer.second)
                assertEquals(status, response.statusCode(), response.body())
                assertEquals(code, mapper.readTree(response.body()).path("code").stringValue())
            }
        }

        @Test
        fun `user lookup requires an authenticated session`() {
            val target = user("unauth_${newId()}")
            for (cookie in listOf(null, "messenger_session=${"A".repeat(43)}")) {
                val response = get(target, cookie)
                assertEquals(401, response.statusCode())
                assertEquals("UNAUTHORIZED", mapper.readTree(response.body()).path("code").stringValue())
            }
        }

        private fun assertUser(id: String, username: String, cookie: String) {
            val response = get(id, cookie)
            assertEquals(200, response.statusCode(), response.body())
            val body = mapper.readTree(response.body())
            assertEquals(setOf("id", "username"), body.propertyNames().toSet())
            assertEquals(id, body.path("id").stringValue())
            assertEquals(username, body.path("username").stringValue())
        }

        private fun account(): Triple<String, String, String> {
            val username = "lookup_${newId().lowercase()}"
            val credentials = authenticationService.register(AuthRequest(username, "long-demo-password"))
            return Triple(credentials.user.id.value, "messenger_session=${credentials.token.value}", username)
        }

        private fun get(id: String, cookie: String? = null): HttpResponse<String> {
            val request = HttpRequest.newBuilder(URI.create("http://localhost:$port/api/v1/users/$id"))
                .timeout(Duration.ofSeconds(10))
            cookie?.let { request.header("Cookie", it) }
            return http.send(request.build(), HttpResponse.BodyHandlers.ofString())
        }
    }
