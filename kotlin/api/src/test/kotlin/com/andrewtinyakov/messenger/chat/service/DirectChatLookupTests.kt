package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
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
class DirectChatLookupTests
    @Autowired
    constructor(
        @Value($$"${local.server.port}") private val port: Int,
        private val authenticationService: AuthenticationService,
        private val messageSendService: MessageSendService,
        private val mapper: ObjectMapper,
    ) : MessengerIntegrationTest() {
        private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

        @Test
        fun `draft reads return the recipient without creating durable state`() {
            val sender = account()
            val recipient = user("draft_${newId()}")
            val username = db.queryForObject("SELECT username FROM users WHERE id=?", String::class.java, recipient)
            val before = durableCounts()

            repeat(2) {
                val response = get(recipient, sender.second)
                assertEquals(200, response.statusCode())
                val body = mapper.readTree(response.body())
                assertEquals(setOf("recipient", "chat"), body.propertyNames().toSet())
                assertEquals(recipient, body.path("recipient").path("id").stringValue())
                assertEquals(username, body.path("recipient").path("username").stringValue())
                assertTrue(body.path("chat").isNull)
            }

            assertEquals(before, durableCounts())
        }

        @Test
        fun `both directions resolve the same committed direct chat with SQL history identity`() {
            val left = account()
            val right = account()
            assertEquals(
                CommandResult.SAVED,
                messageSendService.process(command(left.first, newId(), "hello", recipient = right.first)),
            )
            val chatId = db.queryForObject("SELECT chat_id FROM messages WHERE sender_id=?", String::class.java, left.first)
            val before = durableCounts()

            for ((viewer, recipient) in listOf(left to right, right to left)) {
                val response = get(recipient.first, viewer.second)
                assertEquals(200, response.statusCode())
                val body = mapper.readTree(response.body())
                assertEquals(recipient.first, body.path("recipient").path("id").stringValue())
                val chat = body.path("chat")
                assertEquals(chatId, chat.path("id").stringValue())
                assertEquals("DIRECT", chat.path("kind").stringValue())
                assertEquals("1", chat.path("lastSequence").stringValue())
                assertEquals(2, chat.path("memberCount").intValue())
                assertEquals(setOf(left.first, right.first), chat.path("members").toList().map { it.path("id").stringValue() }.toSet())
            }

            assertEquals(before, durableCounts())
        }

        @Test
        fun `self unknown and malformed recipients return useful client errors`() {
            val sender = account()
            val before = durableCounts()
            val cases = listOf(
                Triple(sender.first, 400, "VALIDATION_FAILED"),
                Triple(newId(), 404, "NOT_FOUND"),
                Triple("invalid", 400, "VALIDATION_FAILED"),
            )

            for ((recipient, status, code) in cases) {
                val response = get(recipient, sender.second)
                assertEquals(status, response.statusCode())
                val body = mapper.readTree(response.body())
                assertEquals(code, body.path("code").stringValue())
                if (recipient == sender.first) {
                    assertEquals("Direct chat recipient must be another user", body.path("detail").stringValue())
                }
            }

            assertEquals(before, durableCounts())
        }

        @Test
        fun `direct lookup requires an authenticated session`() {
            val recipient = user("unauth_${newId()}")
            assertEquals(401, get(recipient).statusCode())
        }

        @Test
        fun `pair lookup retains the existing chat membership check`() {
            val sender = account()
            val recipient = user("membership_${newId()}")
            assertEquals(
                CommandResult.SAVED,
                messageSendService.process(command(sender.first, newId(), "hello", recipient = recipient)),
            )
            db.update("DELETE FROM chat_members WHERE user_id=?", sender.first)

            val response = get(recipient, sender.second)

            assertEquals(404, response.statusCode())
            assertEquals("NOT_FOUND", mapper.readTree(response.body()).path("code").stringValue())
        }

        private fun account(): Pair<String, String> {
            val credentials = authenticationService.register("lookup_${newId()}", "long-demo-password")
            return credentials.user.id.value to "__Host-messenger_session=${credentials.token.value}"
        }

        private fun get(recipient: String, cookie: String? = null): HttpResponse<String> {
            val request = HttpRequest.newBuilder(URI.create("http://localhost:$port/api/v1/chats/direct/$recipient"))
                .timeout(Duration.ofSeconds(10))
            cookie?.let { request.header("Cookie", it) }
            return http.send(request.build(), HttpResponse.BodyHandlers.ofString())
        }

        private fun durableCounts(): List<Long?> =
            listOf("chats", "chat_members", "messages", "send_requests", "messenger_outbox_events").map {
                db.queryForObject("SELECT count(*) FROM $it", Long::class.java)
            }
    }
