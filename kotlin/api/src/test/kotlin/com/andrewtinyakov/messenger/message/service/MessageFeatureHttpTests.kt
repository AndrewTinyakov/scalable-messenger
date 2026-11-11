package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
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
class MessageFeatureHttpTests
    @Autowired
    constructor(
        @Value("\${local.server.port}") private val port: Int,
        private val authentication: AuthenticationService,
        private val chats: ChatService,
        private val sends: MessageSendService,
        private val mapper: ObjectMapper,
    ) : MessengerIntegrationTest() {
        private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

        @Test
        fun `HTTP edit delete around and changes expose explicit nullable versioned state`() {
            val owner = account()
            val member = account()
            val chat = chats.createGroup(UserId(owner.first), CreateGroupChatRequest("HTTP mutations", listOf(member.first))).id
            sends.process(command(owner.first, newId(), "original", chat = chat))
            val initial = mapper.readTree(request("/$chat/messages", owner.second).body())
            val target = initial.path("messages").first()
            val id = target.path("id").stringValue()
            for (field in listOf(
                "editedAt",
                "deletedAt",
                "replyToMessageId",
                "replySenderId",
                "replyBody",
                "replyDeleted",
                "replyVersion",
            )) {
                assertTrue(target.has(field), field)
                assertTrue(target.path(field).isNull, field)
            }
            assertEquals("0", initial.path("mutationRevision").stringValue())
            assertEquals("1", target.path("messageVersion").stringValue())
            assertEquals(
                403,
                request("/$chat/messages/$id", member.second, "PATCH", """{"body":"wrong","expectedVersion":"1"}""").statusCode(),
            )
            val edited = request("/$chat/messages/$id", owner.second, "PATCH", """{"body":"edited","expectedVersion":"1"}""")
            assertEquals(200, edited.statusCode(), edited.body())
            assertEquals("2", mapper.readTree(edited.body()).path("messageVersion").stringValue())
            assertEquals(
                409,
                request("/$chat/messages/$id", owner.second, "PATCH", """{"body":"stale","expectedVersion":"1"}""").statusCode(),
            )
            assertEquals(
                400,
                request("/$chat/messages/$id", owner.second, "PATCH", """{"body":"bad version","expectedVersion":2}""").statusCode(),
            )
            assertEquals(400, request("/$chat/messages/$id", owner.second, "PATCH", """{"body":123,"expectedVersion":"2"}""").statusCode())
            assertEquals(400, request("/$chat/messages/$id", owner.second, "PATCH", """{"body":null,"expectedVersion":"2"}""").statusCode())
            val around = request("/$chat/messages/around?messageId=$id&limit=1", member.second)
            assertEquals(200, around.statusCode(), around.body())
            assertEquals(id, mapper.readTree(around.body()).path("anchorMessageId").stringValue())
            val deleted = request("/$chat/messages/$id?expectedVersion=2", owner.second, "DELETE")
            assertEquals(200, deleted.statusCode(), deleted.body())
            assertEquals("", mapper.readTree(deleted.body()).path("body").stringValue())
            assertEquals("3", mapper.readTree(deleted.body()).path("messageVersion").stringValue())
            val changes = request("/$chat/messages/changes?afterRevision=0&limit=1", member.second)
            assertEquals(200, changes.statusCode(), changes.body())
            val page = mapper.readTree(changes.body())
            assertEquals("2", page.path("lastRevision").stringValue())
            assertEquals("1", page.path("nextRevision").stringValue())
            assertEquals("REMOVED", page.path("changes").first().path("kind").stringValue())
            assertTrue(page.path("changes").first().path("message").isNull)
            assertEquals(204, request("/$chat", owner.second, "DELETE").statusCode())
            assertEquals(404, request("/$chat/messages", member.second).statusCode())
            assertEquals(404, request("/$chat/messages/changes?afterRevision=0", member.second).statusCode())
            assertEquals(404, request("/$chat/messages/around?messageId=$id", member.second).statusCode())
        }

        @Test
        fun `HTTP mutation routes require sessions and reject malformed identifiers`() {
            val owner = account()
            val member = account()
            val chat = chats.createGroup(UserId(owner.first), CreateGroupChatRequest("HTTP auth", listOf(member.first))).id
            sends.process(command(owner.first, newId(), "text", chat = chat))
            val id = db.queryForObject("SELECT id FROM messages WHERE chat_id=?", String::class.java, chat)!!
            assertEquals(401, request("/$chat/messages/$id?expectedVersion=1", null, "DELETE").statusCode())
            assertEquals(400, request("/$chat/messages/invalid?expectedVersion=1", owner.second, "DELETE").statusCode())
            assertEquals(400, request("/$chat/messages/$id?expectedVersion=01", owner.second, "DELETE").statusCode())
            assertEquals(400, request("/$chat/messages/around?messageId=$id&limit=101", owner.second).statusCode())
            assertEquals(400, request("/$chat/messages/changes?afterRevision=01", owner.second).statusCode())
        }

        @Test
        fun `HTTP scoped deletion resolves account visibility and returns durable operation status`() {
            val owner = account()
            val member = account()
            val chat = chats.createGroup(UserId(owner.first), CreateGroupChatRequest("HTTP scoped deletion", listOf(member.first))).id
            sends.process(command(owner.first, newId(), "private hide", chat = chat))
            val target = db.queryForObject("SELECT id FROM messages WHERE chat_id=?", String::class.java, chat)!!
            val requestId = newId()
            val accepted =
                request(
                    "/$chat/deletions",
                    member.second,
                    "POST",
                    """{"requestId":"$requestId","scope":"SELF","target":"MESSAGES","messageIds":["$target"]}""",
                )
            assertEquals(200, accepted.statusCode(), accepted.body())
            val operation = mapper.readTree(accepted.body())
            assertEquals(requestId, operation.path("operationId").stringValue())
            assertEquals("COMPLETED", operation.path("state").stringValue())
            assertEquals("1", operation.path("visibilityRevision").stringValue())
            val resolved = request("/$chat/messages/resolve", member.second, "POST", """{"messageIds":["$target"]}""")
            assertEquals(200, resolved.statusCode(), resolved.body())
            assertEquals(0, mapper.readTree(resolved.body()).path("messages").size())
            val visibility = mapper.readTree(request("/$chat/visibility", member.second).body())
            assertEquals("1", visibility.path("snapshotSequence").stringValue())
            assertEquals("1", visibility.path("visibilityRevision").stringValue())
            assertEquals(200, request("/$chat/deletions/$requestId", member.second).statusCode())
            assertEquals(404, request("/$chat/deletions/$requestId", owner.second).statusCode())
            assertEquals(
                409,
                request(
                    "/$chat/deletions",
                    member.second,
                    "POST",
                    """{"requestId":"$requestId","scope":"SELF","target":"CHAT"}""",
                ).statusCode(),
            )
            assertEquals(
                400,
                request(
                    "/$chat/deletions",
                    member.second,
                    "POST",
                    """{"requestId":"${newId()}","scope":"SELF","target":"MESSAGES","messageIds":[12345678901234567890123456]}""",
                ).statusCode(),
            )
            assertEquals(401, request("/$chat/visibility", null).statusCode())
        }

        private fun account(): Pair<String, String> {
            val registered = authentication.register(AuthRequest("mutations_${newId()}", "long-demo-password"))
            return registered.user.id.value to "messenger_session=${registered.token.value}"
        }

        private fun request(path: String, cookie: String?, method: String = "GET", body: String = ""): HttpResponse<String> {
            val request = HttpRequest.newBuilder(URI.create("http://localhost:$port/api/v1/chats$path"))
                .timeout(Duration.ofSeconds(10))
            cookie?.let { request.header("Cookie", it) }
            if (method != "GET") {
                request.header("Content-Type", "application/json").header("Origin", "http://localhost:5173")
                    .header("X-Messenger-CSRF", "1")
            }
            return http.send(
                request.method(method, HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        }
    }
