package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ChatTests {
    private val direct = Chat(
        id = ChatId(newId()),
        kind = ChatKind.DIRECT,
        name = null,
        lastSequence = 0,
        ownerId = null,
        memberCount = 2,
    )

    @Test
    fun `chat accepts zero and positive history sequences`() {
        assertEquals(0L, direct.lastSequence)
        assertEquals(Long.MAX_VALUE, direct.copy(lastSequence = Long.MAX_VALUE).lastSequence)
        assertThrows(IllegalArgumentException::class.java) { direct.copy(lastSequence = -1) }
    }

    @Test
    fun `chat ownership follows chat kind and count is bounded`() {
        assertThrows(IllegalArgumentException::class.java) { direct.copy(ownerId = UserId(newId())) }
        assertThrows(IllegalArgumentException::class.java) { direct.copy(kind = ChatKind.GROUP, name = "Group") }
        assertThrows(IllegalArgumentException::class.java) { direct.copy(memberCount = -1) }
        assertThrows(IllegalArgumentException::class.java) { direct.copy(memberCount = 100_001) }
        assertEquals(100_000, direct.copy(memberCount = 100_000).memberCount)
    }

    @Test
    fun `direct chat requires an absent group name`() {
        for (name in listOf("", " ", "Group")) {
            assertThrows(IllegalArgumentException::class.java) { direct.copy(name = name) }
        }
    }

    @Test
    fun `group chat requires a nonblank name of at most eighty characters`() {
        for (name in listOf(null, "", " ", "\t\n", "g".repeat(81))) {
            assertThrows(IllegalArgumentException::class.java) {
                direct.copy(kind = ChatKind.GROUP, name = name, ownerId = UserId(newId()))
            }
        }
        for (name in listOf("g", "Group", "g".repeat(80))) {
            assertEquals(name, direct.copy(kind = ChatKind.GROUP, name = name, ownerId = UserId(newId())).name)
        }
    }
}
