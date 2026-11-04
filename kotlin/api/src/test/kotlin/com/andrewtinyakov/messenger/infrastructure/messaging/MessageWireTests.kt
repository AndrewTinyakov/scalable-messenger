package com.andrewtinyakov.messenger.infrastructure.messaging

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.message.web.payload.SendStatusResponse
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import tools.jackson.core.JacksonException
import tools.jackson.databind.ObjectMapper

class MessageWireTests
    @Autowired
    constructor(
        private val mapper: ObjectMapper,
    ) : MessengerIntegrationTest() {
        @Test
        fun `generated event factory serializes fixed type and version while decoding requires both`() {
            val event = SendRejectedEventV1.create(
                eventId = newId(),
                room = "user:${newId()}",
                chatId = newId(),
                requestId = newId(),
                reason = SendRejectionReason.NOT_A_MEMBER,
            )
            val json = mapper.writeValueAsString(event)
            val node = mapper.readTree(json)
            assertEquals("send_rejected", node.path("type").stringValue())
            assertEquals(1, node.path("version").intValue())
            assertEquals(event, mapper.readValue(json, SendRejectedEventV1::class.java))
            for (invalid in listOf(
                json.replace("\"type\":\"send_rejected\",", ""),
                json.replace("\"version\":1,", ""),
                json.replace("\"type\":\"send_rejected\"", "\"type\":\"message_saved\""),
                json.replace("\"version\":1", "\"version\":2"),
            )) {
                assertThrows(JacksonException::class.java, { mapper.readValue(invalid, SendRejectedEventV1::class.java) }, invalid)
            }
        }

        @Test
        fun `HTTP response models serialize default uppercase enums`() {
            val chat = ChatResponse(
                id = newId(),
                kind = ChatKind.GROUP,
                name = "Group",
                members = emptyList(),
                memberCount = 2,
                lastSequence = "0",
            )
            assertEquals("GROUP", mapper.readTree(mapper.writeValueAsString(chat)).path("kind").stringValue())
            for (status in SendLookupStatus.entries) {
                val response = SendStatusResponse(status = status)
                assertEquals(status.name, mapper.readTree(mapper.writeValueAsString(response)).path("status").stringValue())
            }
        }

        @Test
        fun `command decoder rejects duplicate fields`() {
            val send = command(newId(), newId(), "hello", chat = newId())
            val json = mapper.writeValueAsString(send)

            assertThrows(JacksonException::class.java) {
                mapper.readValue(json.dropLast(1) + ",\"body\":\"replacement\"}", SendMessageCommandV1::class.java)
            }
        }

        @Test
        fun `command decoder rejects unknown fields and trailing JSON`() {
            val send = command(newId(), newId(), "hello", chat = newId())
            val json = mapper.writeValueAsString(send)
            assertEquals(send, mapper.readValue(json, SendMessageCommandV1::class.java))
            assertThrows(JacksonException::class.java) {
                mapper.readValue(json.dropLast(1) + ",\"unknown\":true}", SendMessageCommandV1::class.java)
            }
            assertThrows(JacksonException::class.java) { mapper.readValue("$json {}", SendMessageCommandV1::class.java) }
            val rejection = SendRejectedEventV1(
                type = "send_rejected",
                version = 1,
                eventId = newId(),
                room = "user:${newId()}",
                chatId = newId(),
                requestId = newId(),
                reason = SendRejectionReason.NOT_A_MEMBER,
            )
            assertFalse(mapper.writeValueAsString(rejection).contains("messageId"))
        }
    }
