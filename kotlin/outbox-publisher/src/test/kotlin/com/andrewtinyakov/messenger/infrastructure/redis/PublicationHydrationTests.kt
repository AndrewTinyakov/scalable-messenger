package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.generated.messaging.event.SavedMessageReferenceV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.fasterxml.jackson.annotation.JsonInclude
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import tools.jackson.databind.json.JsonMapper
import java.time.OffsetDateTime

class PublicationHydrationTests {
    private val mapper = JsonMapper.builder()
        .changeDefaultPropertyInclusion { it.withValueInclusion(JsonInclude.Include.NON_NULL) }.build()
    private val repository = mock(MessageRepository::class.java)
    private val hydration = PublicationHydration(repository, mapper, SimpleMeterRegistry())
    private val chat = ChatId(newId())
    private val id = MessageId(newId())

    @Test
    fun `direct recipient publications hydrate one current message and retain no replay body or quote`() {
        val target = MessageId(newId())
        val message = Message(id, chat, 8, UserId(newId()), "current body", OffsetDateTime.now(), replyToMessageId = target)
        `when`(repository.findMessagesForPublication(listOf(id))).thenReturn(listOf(message))
        val rows = listOf(reference("user:${newId()}"), reference("user:${newId()}"))
        val result = hydration.prepare(rows)
        verify(repository).findMessagesForPublication(listOf(id))
        result.forEach { row ->
            val live = mapper.readValue(row.payload, Map::class.java)
            assertEquals("current body", live["body"])
            assertEquals(target.value, live["replyToMessageId"])
            assertFalse(live.containsKey("replyBody"))
            val replay = mapper.readValue(row.replayPayload, Map::class.java)
            assertEquals("history_changed", replay["type"])
            assertEquals("8", replay["sequence"])
            assertFalse(replay.containsKey("body"))
            assertFalse(replay.containsKey("replyBody"))
        }
    }

    @Test
    fun `a message deleted after claim produces only a bodyless recovery hint`() {
        `when`(repository.findMessagesForPublication(listOf(id))).thenReturn(emptyList())
        val row = hydration.prepare(listOf(reference("group:${chat.value}"))).single()
        assertEquals(row.payload, row.replayPayload)
        val live = mapper.readValue(row.payload, Map::class.java)
        assertEquals("history_changed", live["type"])
        assertFalse(live.containsKey("body"))
        assertFalse(live.containsKey("requestId"))
    }

    private fun reference(room: String): OutboxMessage {
        val eventId = EventId(newId())
        return OutboxMessage(
            eventId,
            room,
            mapper.writeValueAsString(SavedMessageReferenceV1.create(eventId.value, room, chat.value, newId(), id.value, "8")),
        )
    }
}
