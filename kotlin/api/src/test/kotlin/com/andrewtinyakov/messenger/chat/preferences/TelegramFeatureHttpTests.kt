package com.andrewtinyakov.messenger.chat.preferences

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
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
import java.time.OffsetDateTime

@SpringBootTest(
    classes = [ApiApplication::class],
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = ["messenger.grpc.enabled=false", "spring.rabbitmq.dynamic=false", "spring.rabbitmq.listener.simple.auto-startup=false"],
)
class TelegramFeatureHttpTests
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
        fun `pinned chats lead the first page in rank order and reorder only the current set`() {
            val owner = account()
            val member = account()
            val groups = (1..4).map { chats.createGroup(UserId(owner.first), CreateGroupChatRequest("Pins $it", listOf(member.first))).id }
            assertEquals(listOf(groups[0]), ids(request("/${groups[0]}/pin", owner.second, "PUT")))
            assertEquals(listOf(groups[2], groups[0]), ids(request("/${groups[2]}/pin", owner.second, "PUT")))
            assertEquals(listOf(groups[2], groups[0]), ids(request("/${groups[2]}/pin", owner.second, "PUT")))
            assertEquals(1, outbox(owner.first, "chat_preferences_changed", groups[2]))

            val first = page("?limit=1", owner.second)
            assertEquals(listOf(groups[2], groups[0], groups[3]), first.path("chats").toList().map { it.path("id").stringValue() })
            assertEquals(listOf(1, 2), first.path("chats").toList().take(2).map { it.path("pinnedRank").intValue() })
            assertFalse(first.path("chats")[2].has("pinnedRank"))
            val second = page("?limit=10&cursor=${first.path("nextCursor").stringValue()}", owner.second)
            assertEquals(listOf(groups[1]), second.path("chats").toList().map { it.path("id").stringValue() })
            assertTrue(page("", member.second).path("chats").toList().none { it.has("pinnedRank") })

            val reordered = request("/pinned", owner.second, "PUT", """{"chatIds":["${groups[0]}","${groups[2]}"]}""")
            assertEquals(listOf(groups[0], groups[2]), ids(reordered))
            assertEquals(409, request("/pinned", owner.second, "PUT", """{"chatIds":["${groups[0]}"]}""").statusCode())
            assertEquals(409, request("/pinned", owner.second, "PUT", """{"chatIds":["${groups[0]}","${groups[0]}"]}""").statusCode())
            assertEquals(listOf(groups[2]), ids(request("/${groups[0]}/pin", owner.second, "DELETE")))
            val outsider = account()
            assertEquals(404, request("/${groups[1]}/pin", outsider.second, "PUT").statusCode())
        }

        @Test
        fun `pinning stops at ten chats and hiding a chat unpins it`() {
            val owner = account()
            val member = account()
            val groups = (1..11).map {
                chats.createGroup(UserId(owner.first), CreateGroupChatRequest("Limit $it", listOf(member.first))).id
            }
            groups.take(10).forEach { assertEquals(200, request("/$it/pin", owner.second, "PUT").statusCode()) }
            assertEquals(409, request("/${groups[10]}/pin", owner.second, "PUT").statusCode())
            val hidden =
                request("/${groups[9]}/deletions", owner.second, "POST", """{"requestId":"${newId()}","scope":"SELF","target":"CHAT"}""")
            assertEquals(200, hidden.statusCode(), hidden.body())
            assertEquals(200, request("/${groups[10]}/pin", owner.second, "PUT").statusCode())
            assertEquals(10, ids(request("/${groups[10]}/pin", owner.second, "PUT")).size)
        }

        @Test
        fun `mute and unread marks are personal and expire without cleanup`() {
            val owner = account()
            val member = account()
            val group = chats.createGroup(UserId(owner.first), CreateGroupChatRequest("Mute", listOf(member.first))).id
            val timed = json(request("/$group/mute", owner.second, "PUT", """{"durationSeconds":3600}"""))
            assertFalse(timed.path("mutedForever").booleanValue())
            assertTrue(OffsetDateTime.parse(timed.path("mutedUntil").stringValue()).isAfter(OffsetDateTime.now().plusMinutes(59)))
            assertEquals(400, request("/$group/mute", owner.second, "PUT", """{"durationSeconds":5}""").statusCode())
            val forever = json(request("/$group/mute", owner.second, "PUT", "{}"))
            assertTrue(forever.path("mutedForever").booleanValue())
            assertTrue(forever.path("mutedUntil").isNull)
            assertTrue(json(request("/$group", owner.second)).path("mutedForever").booleanValue())
            assertFalse(json(request("/$group", member.second)).path("mutedForever").booleanValue())
            db.update("UPDATE chat_members SET muted_until = now() - interval '1 minute' WHERE chat_id=? AND user_id=?", group, owner.first)
            val expired = json(request("/$group", owner.second))
            assertFalse(expired.path("mutedForever").booleanValue())
            assertFalse(expired.has("mutedUntil"))
            assertFalse(json(request("/$group/mute", owner.second, "DELETE")).path("mutedForever").booleanValue())

            assertTrue(json(request("/$group/unread-mark", member.second, "PUT")).path("markedUnread").booleanValue())
            assertTrue(json(request("/$group", member.second)).path("markedUnread").booleanValue())
            assertFalse(json(request("/$group", owner.second)).path("markedUnread").booleanValue())
            assertFalse(json(request("/$group/unread-mark", member.second, "DELETE")).path("markedUnread").booleanValue())
            assertEquals(404, request("/$group/unread-mark", account().second, "PUT").statusCode())
            assertTrue(outbox(member.first, "chat_preferences_changed", group) >= 2)
        }

        @Test
        fun `message pins honour scope, visibility, caps and cascade with deleted messages`() {
            val alice = account()
            val bob = account()
            sends.process(command(alice.first, newId(), "first", recipient = bob.first))
            val direct = db.queryForObject("SELECT chat_id FROM messages WHERE sender_id=?", String::class.java, alice.first)!!
            sends.process(command(alice.first, newId(), "second", chat = direct))
            sends.process(command(bob.first, newId(), "third", chat = direct))
            val (first, second, third) = db.queryForList(
                "SELECT id FROM messages WHERE chat_id=? ORDER BY sequence",
                String::class.java,
                direct,
            )

            assertEquals(204, request("/$direct/pins/$first", alice.second, "PUT", """{"scope":"SELF"}""").statusCode())
            assertEquals(204, request("/$direct/pins/$third", bob.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            assertEquals(204, request("/$direct/pins/$third", bob.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            val alicePins = json(request("/$direct/pins", alice.second))
            assertEquals(2, alicePins.path("totalCount").intValue())
            assertEquals(listOf(third, first), alicePins.path("pins").toList().map { it.path("message").path("id").stringValue() })
            assertEquals(listOf("EVERYONE", "SELF"), alicePins.path("pins").toList().map { it.path("scope").stringValue() })
            assertEquals(listOf(third, first), alicePins.path("pinnedMessageIds").toList().map { it.stringValue() })
            assertEquals(
                listOf(third),
                json(request("/$direct/pins", bob.second)).path("pins").toList().map {
                    it.path("message").path("id").stringValue()
                },
            )
            assertEquals(2, outbox(alice.first, "pins_changed", direct, user = true))
            assertEquals(1, outbox(bob.first, "pins_changed", direct, user = true))

            val paged = json(request("/$direct/pins?limit=1", alice.second))
            assertEquals(
                paged.path("pins")[0].path("message").path("sequence").stringValue(),
                paged.path("nextBeforeSequence").stringValue(),
            )
            val older =
                json(request("/$direct/pins?limit=1&beforeSequence=${paged.path("nextBeforeSequence").stringValue()}", alice.second))
            assertEquals(first, older.path("pins")[0].path("message").path("id").stringValue())

            val hidden = request(
                "/$direct/deletions",
                alice.second,
                "POST",
                """{"requestId":"${newId()}","scope":"SELF","target":"MESSAGES","messageIds":["$first"]}""",
            )
            assertEquals(200, hidden.statusCode(), hidden.body())
            assertEquals(1, json(request("/$direct/pins", alice.second)).path("totalCount").intValue())

            assertEquals(204, request("/$direct/pins/$second", alice.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            val version = db.queryForObject("SELECT message_version FROM messages WHERE id=?", Long::class.java, second)
            assertEquals(200, request("/$direct/messages/$second?expectedVersion=$version", bob.second, "DELETE").statusCode())
            assertEquals(0, db.queryForObject("SELECT count(*) FROM message_pins WHERE chat_id=? AND sequence=2", Int::class.java, direct))

            assertEquals(204, request("/$direct/pins/$third", alice.second, "DELETE").statusCode())
            assertEquals(0, json(request("/$direct/pins", bob.second)).path("totalCount").intValue())
            assertEquals(404, request("/$direct/pins", account().second).statusCode())

            val group = chats.createGroup(UserId(alice.first), CreateGroupChatRequest("Group pins", listOf(bob.first))).id
            sends.process(command(bob.first, newId(), "group text", chat = group))
            val groupMessage = db.queryForObject("SELECT id FROM messages WHERE chat_id=?", String::class.java, group)!!
            assertEquals(400, request("/$group/pins/$groupMessage", bob.second, "PUT", """{"scope":"SELF"}""").statusCode())
            assertEquals(204, request("/$group/pins/$groupMessage", bob.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            assertEquals(1, outbox(group, "pins_changed", group, user = false))
            assertEquals(204, request("/$group/pins", alice.second, "DELETE").statusCode())
            assertEquals(0, json(request("/$group/pins", bob.second)).path("totalCount").intValue())
        }

        @Test
        fun `removing a personal pin notifies only its owner`() {
            val alice = account()
            val bob = account()
            sends.process(command(alice.first, newId(), "private reminder", recipient = bob.first))
            val direct = db.queryForObject("SELECT chat_id FROM messages WHERE sender_id=?", String::class.java, alice.first)!!
            val message = db.queryForObject("SELECT id FROM messages WHERE chat_id=?", String::class.java, direct)!!
            assertEquals(204, request("/$direct/pins/$message", alice.second, "PUT", """{"scope":"SELF"}""").statusCode())
            assertEquals(204, request("/$direct/pins/$message", alice.second, "DELETE").statusCode())
            assertEquals(204, request("/$direct/pins/$message", alice.second, "PUT", """{"scope":"SELF"}""").statusCode())
            assertEquals(204, request("/$direct/pins", alice.second, "DELETE").statusCode())
            assertEquals(4, outbox(alice.first, "pins_changed", direct))
            assertEquals(0, outbox(bob.first, "pins_changed", direct))
            assertEquals(204, request("/$direct/pins/$message", bob.second, "DELETE").statusCode())
            assertEquals(0, outbox(bob.first, "pins_changed", direct))
        }

        @Test
        fun `a chat keeps at most two hundred shared pins`() {
            val owner = account()
            val member = account()
            val group = chats.createGroup(UserId(owner.first), CreateGroupChatRequest("Pin cap", listOf(member.first))).id
            repeat(201) { sends.process(command(owner.first, newId(), "message $it", chat = group)) }
            db.update(
                "INSERT INTO message_pins(chat_id, sequence) SELECT chat_id, sequence FROM messages WHERE chat_id=? AND sequence <= 200",
                group,
            )
            val last = db.queryForObject("SELECT id FROM messages WHERE chat_id=? AND sequence=201", String::class.java, group)
            assertEquals(409, request("/$group/pins/$last", owner.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            val pinned = db.queryForObject("SELECT id FROM messages WHERE chat_id=? AND sequence=1", String::class.java, group)
            assertEquals(204, request("/$group/pins/$pinned", owner.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            val page = json(request("/$group/pins", member.second))
            assertEquals(200, page.path("totalCount").intValue())
            assertEquals(50, page.path("pins").size())
            assertEquals(200, page.path("pinnedMessageIds").size())
            assertEquals(pinned, page.path("pinnedMessageIds").toList().last().stringValue())
        }

        private fun outbox(target: String, type: String, chatId: String, user: Boolean = true): Int =
            db.queryForObject(
                "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'type'=? AND payload->>'chatId'=?",
                Int::class.java,
                if (user) "user:$target" else "group:$target",
                type,
                chatId,
            )!!

        private fun ids(response: HttpResponse<String>): List<String> {
            assertEquals(200, response.statusCode(), response.body())
            return mapper.readTree(response.body()).path("chatIds").toList().map { it.stringValue() }
        }

        private fun json(response: HttpResponse<String>): JsonNode {
            assertEquals(200, response.statusCode(), response.body())
            return mapper.readTree(response.body())
        }

        private fun page(query: String, cookie: String): JsonNode = json(request(query, cookie))

        private fun account(): Pair<String, String> {
            val registered = authentication.register(AuthRequest("telegram_${newId()}", "long-demo-password"))
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
