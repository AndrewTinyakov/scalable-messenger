package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_PINS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.jooq.impl.DSL
import org.jooq.types.DayToSecond
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
        @Value($$"${local.server.port}") private val port: Int,
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
            val groups = (1..4).map { chats.createGroup(UserId(owner.first), "Pins $it", listOf(member.first).map(::UserId)).id }
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
                chats.createGroup(UserId(owner.first), "Limit $it", listOf(member.first).map(::UserId)).id
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
            val group = chats.createGroup(UserId(owner.first), "Mute", listOf(member.first).map(::UserId)).id
            val timed = json(request("/$group/mute", owner.second, "PUT", """{"durationSeconds":3600}"""))
            assertFalse(timed.path("mutedForever").booleanValue())
            assertTrue(OffsetDateTime.parse(timed.path("mutedUntil").stringValue()).isAfter(OffsetDateTime.now().plusMinutes(59)))
            assertEquals(400, request("/$group/mute", owner.second, "PUT", """{"durationSeconds":5}""").statusCode())
            val forever = json(request("/$group/mute", owner.second, "PUT", "{}"))
            assertTrue(forever.path("mutedForever").booleanValue())
            assertTrue(forever.path("mutedUntil").isNull)
            assertTrue(json(request("/$group", owner.second)).path("mutedForever").booleanValue())
            assertFalse(json(request("/$group", member.second)).path("mutedForever").booleanValue())
            db.update(CHAT_MEMBERS)
                .set(CHAT_MEMBERS.MUTED_UNTIL, DSL.currentOffsetDateTime().sub(DSL.inline(DayToSecond.valueOf(Duration.ofMinutes(1)))))
                .where(CHAT_MEMBERS.CHAT_ID.eq(group), CHAT_MEMBERS.USER_ID.eq(owner.first)).execute()
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
            val direct = db.fetchValue(MESSAGES.CHAT_ID, MESSAGES.SENDER_ID.eq(alice.first))!!
            sends.process(command(alice.first, newId(), "second", chat = direct))
            sends.process(command(bob.first, newId(), "third", chat = direct))
            val (first, second, third) = db.select(MESSAGES.ID).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(direct))
                .orderBy(MESSAGES.SEQUENCE).fetch(MESSAGES.ID)

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
            val version = db.fetchValue(MESSAGES.MESSAGE_VERSION, MESSAGES.ID.eq(second))!!
            assertEquals(200, request("/$direct/messages/$second?expectedVersion=$version", bob.second, "DELETE").statusCode())
            assertEquals(0, db.fetchCount(MESSAGE_PINS, MESSAGE_PINS.CHAT_ID.eq(direct), MESSAGE_PINS.SEQUENCE.eq(2L)))

            assertEquals(204, request("/$direct/pins/$third", alice.second, "DELETE").statusCode())
            assertEquals(0, json(request("/$direct/pins", bob.second)).path("totalCount").intValue())
            assertEquals(404, request("/$direct/pins", account().second).statusCode())

            val group = chats.createGroup(UserId(alice.first), "Group pins", listOf(bob.first).map(::UserId)).id
            sends.process(command(bob.first, newId(), "group text", chat = group))
            val groupMessage = db.fetchValue(MESSAGES.ID, MESSAGES.CHAT_ID.eq(group))!!
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
            val direct = db.fetchValue(MESSAGES.CHAT_ID, MESSAGES.SENDER_ID.eq(alice.first))!!
            val message = db.fetchValue(MESSAGES.ID, MESSAGES.CHAT_ID.eq(direct))!!
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
            val group = chats.createGroup(UserId(owner.first), "Pin cap", listOf(member.first).map(::UserId)).id
            repeat(201) { sends.process(command(owner.first, newId(), "message $it", chat = group)) }
            db.insertInto(MESSAGE_PINS, MESSAGE_PINS.CHAT_ID, MESSAGE_PINS.SEQUENCE).select(
                db.select(MESSAGES.CHAT_ID, MESSAGES.SEQUENCE).from(MESSAGES)
                    .where(MESSAGES.CHAT_ID.eq(group), MESSAGES.SEQUENCE.le(200L)),
            ).execute()
            val last = db.fetchValue(MESSAGES.ID, MESSAGES.CHAT_ID.eq(group).and(MESSAGES.SEQUENCE.eq(201L)))!!
            assertEquals(409, request("/$group/pins/$last", owner.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            val pinned = db.fetchValue(MESSAGES.ID, MESSAGES.CHAT_ID.eq(group).and(MESSAGES.SEQUENCE.eq(1L)))!!
            assertEquals(204, request("/$group/pins/$pinned", owner.second, "PUT", """{"scope":"EVERYONE"}""").statusCode())
            val page = json(request("/$group/pins", member.second))
            assertEquals(200, page.path("totalCount").intValue())
            assertEquals(50, page.path("pins").size())
            assertEquals(200, page.path("pinnedMessageIds").size())
            assertEquals(pinned, page.path("pinnedMessageIds").toList().last().stringValue())
        }

        private fun outbox(target: String, type: String, chatId: String, user: Boolean = true): Int =
            db.fetchCount(
                MESSENGER_OUTBOX_EVENTS,
                MESSENGER_OUTBOX_EVENTS.ROOM.eq(if (user) "user:$target" else "group:$target"),
                DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq(type),
                DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "chatId").eq(chatId),
            )

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
            val registered = authentication.register("telegram_${newId()}", "long-demo-password")
            return registered.user.id.value to "__Host-messenger_session=${registered.token.value}"
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
