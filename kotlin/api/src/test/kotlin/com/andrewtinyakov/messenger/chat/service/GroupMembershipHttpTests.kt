package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.test.context.SpringBootTest
import tools.jackson.databind.JsonNode
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
class GroupMembershipHttpTests
    @Autowired
    constructor(
        @Value($$"${local.server.port}") private val port: Int,
        private val authenticationService: AuthenticationService,
        private val chatService: ChatService,
        private val messageSendService: MessageSendService,
        private val mapper: ObjectMapper,
    ) : MessengerIntegrationTest() {
        private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

        @Test
        fun `owner and member list current users while only owner changes membership`() {
            val owner = account()
            val member = account()
            val addition = account()
            val created =
                request(
                    "/groups",
                    owner.second,
                    "POST",
                    mapper.writeValueAsString(CreateGroupChatRequest("HTTP group", listOf(member.first))),
                )
            assertEquals(201, created.statusCode())
            val chat = mapper.readTree(created.body())
            val id = chat.path("id").stringValue()
            assertEquals(owner.first, chat.path("ownerId").stringValue())
            val expected = listOf(owner.first, member.first).sorted()
            for (viewer in listOf(owner, member)) {
                val listed = page(id, viewer.second)
                assertEquals(expected, ids(listed))
                assertTrue(listed.path("nextCursor").isNull)
                assertEquals(
                    expected.map { legacyJdbc.queryForObject("SELECT username FROM users WHERE id=?", String::class.java, it) },
                    listed.path("members").toList().map { it.path("username").stringValue() },
                )
                assertEquals(owner.first, mapper.readTree(request("/$id", viewer.second).body()).path("ownerId").stringValue())
                val chats = mapper.readTree(request("", viewer.second).body()).path("chats")
                assertEquals(owner.first, chats.first { it.path("id").stringValue() == id }.path("ownerId").stringValue())
            }
            val addBody = mapper.writeValueAsString(mapOf("memberIds" to listOf(addition.first)))
            assertEquals(403, request("/$id/members", member.second, "POST", addBody).statusCode())
            assertEquals(403, request("/$id/members/${owner.first}", member.second, "DELETE").statusCode())
            assertEquals(400, request("/$id/members/${owner.first}", owner.second, "DELETE").statusCode())
            assertEquals(404, request("/$id/members", addition.second).statusCode())
            assertEquals(204, request("/$id/members", owner.second, "POST", addBody).statusCode())
            assertEquals((expected + addition.first).sorted(), ids(page(id, addition.second)))
            assertEquals(204, request("/$id/members/${addition.first}", owner.second, "DELETE").statusCode())
            assertEquals(404, request("/$id/members", addition.second).statusCode())
            assertEquals(expected, ids(page(id, owner.second)))
            assertEquals(204, request("/$id/members", owner.second, "POST", addBody).statusCode())
            assertEquals((expected + addition.first).sorted(), ids(page(id, addition.second)))
        }

        @Test
        fun `pagination visits more than fifty members once in increasing user ID order`() {
            val owner = account()
            val members = (1..120).map { user("page_${newId()}") }
            val chat = chatService.createGroup(UserId(owner.first), "Paged", members.map(::UserId))
            val expected = (members + owner.first).sorted()
            val first = page(chat.id, owner.second)
            assertEquals(expected.take(50), ids(first))
            assertEquals(expected[49], first.path("nextCursor").stringValue())
            val second = page(chat.id, owner.second, "?afterUserId=${first.path("nextCursor").stringValue()}")
            assertEquals(expected.subList(50, 100), ids(second))
            assertEquals(expected[99], second.path("nextCursor").stringValue())
            val third = page(chat.id, owner.second, "?afterUserId=${second.path("nextCursor").stringValue()}")
            assertEquals(expected.drop(100), ids(third))
            assertTrue(third.path("nextCursor").isNull)
            assertEquals(expected, ids(first) + ids(second) + ids(third))
            val end = page(chat.id, owner.second, "?afterUserId=${expected.last()}")
            assertEquals(emptyList<String>(), ids(end))
            assertTrue(end.path("nextCursor").isNull)
            val one = page(chat.id, owner.second, "?limit=1")
            assertEquals(expected.take(1), ids(one))
            assertEquals(expected.first(), one.path("nextCursor").stringValue())
            assertEquals(expected.take(100), ids(page(chat.id, owner.second, "?limit=100")))
        }

        @Test
        fun `member listing validates IDs and limits and requires authentication`() {
            val owner = account()
            val member = user("validation_${newId()}")
            val chat = chatService.createGroup(UserId(owner.first), "Validation", listOf(member).map(::UserId))
            assertEquals(401, request("/${chat.id}/members").statusCode())
            for ((suffix, field) in listOf(
                "?limit=0" to "limit",
                "?limit=101" to "limit",
                "?limit=-1" to "limit",
                "?limit=bad" to "limit",
                "?afterUserId=invalid" to null,
                "?afterUserId=" to null,
                "?afterUserId=${member.lowercase()}" to null,
            )) {
                val response = request("/${chat.id}/members$suffix", owner.second)
                val problem = mapper.readTree(response.body())
                assertEquals(400, response.statusCode(), suffix)
                assertEquals("VALIDATION_FAILED", problem.path("code").stringValue(), suffix)
                assertEquals(field, problem.path("errors").path(0).path("field").stringValue(null), suffix)
            }
            val invalidChat = request("/invalid/members", owner.second)
            assertEquals(400, invalidChat.statusCode())
            assertEquals("VALIDATION_FAILED", mapper.readTree(invalidChat.body()).path("code").stringValue())
            assertEquals(404, request("/${newId()}/members", owner.second).statusCode())
        }

        @Test
        fun `direct chats do not expose a group member page or owner`() {
            val sender = account()
            val recipient = user("direct_${newId()}")
            messageSendService.process(command(sender.first, newId(), "hello", recipient = recipient))
            val chatId = legacyJdbc.queryForObject("SELECT chat_id FROM messages WHERE sender_id=?", String::class.java, sender.first)
            assertEquals(404, request("/$chatId/members", sender.second).statusCode())
            val opened = mapper.readTree(request("/$chatId", sender.second).body())
            assertTrue(opened.path("ownerId").isNull || opened.path("ownerId").isMissingNode)
        }

        private fun ids(page: JsonNode): List<String> = page.path("members").toList().map { it.path("id").stringValue() }

        private fun page(chatId: String, cookie: String, query: String = ""): JsonNode {
            val response = request("/$chatId/members$query", cookie)
            assertEquals(200, response.statusCode(), response.body())
            val page = mapper.readTree(response.body())
            assertEquals(setOf("members", "nextCursor"), page.propertyNames().toSet())
            return page
        }

        private fun account(): Pair<String, String> {
            val credentials = authenticationService.register("members_${newId()}", "long-demo-password")
            return credentials.user.id.value to "__Host-messenger_session=${credentials.token.value}"
        }

        private fun request(path: String, cookie: String? = null, method: String = "GET", body: String = ""): HttpResponse<String> {
            val request = HttpRequest.newBuilder(URI.create("http://localhost:$port/api/v1/chats$path"))
                .timeout(Duration.ofSeconds(10))
            cookie?.let { request.header("Cookie", it) }
            if (method != "GET") {
                request.header("Content-Type", "application/json")
                    .header("Origin", "http://localhost:5173")
                    .header("X-Messenger-CSRF", "1")
            }
            return http.send(
                request.method(method, HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        }
    }
