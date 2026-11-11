package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.time.OffsetDateTime

class MessageTests {
    private val message = Message(
        id = MessageId(newId()),
        chatId = ChatId(newId()),
        sequence = 1,
        senderId = UserId(newId()),
        body = "Hello",
        createdAt = OffsetDateTime.parse("2026-10-20T00:00:00Z"),
    )

    @Test
    fun `message requires a positive sequence`() {
        for (sequence in listOf(0L, -1L)) {
            assertThrows(IllegalArgumentException::class.java) { message.copy(sequence = sequence) }
        }
        assertEquals(Long.MAX_VALUE, message.copy(sequence = Long.MAX_VALUE).sequence)
    }

    @Test
    fun `message rejects blank and overlimit bodies`() {
        for (body in listOf("", " ", "\t\n", "m".repeat(4001), "🙂".repeat(4001))) {
            assertThrows(IllegalArgumentException::class.java) { message.copy(body = body) }
        }
    }

    @Test
    fun `message body limit counts Unicode code points`() {
        for (body in listOf("m", "m".repeat(4000), "🙂".repeat(4000))) {
            assertEquals(body, message.copy(body = body).body)
        }
    }
}
