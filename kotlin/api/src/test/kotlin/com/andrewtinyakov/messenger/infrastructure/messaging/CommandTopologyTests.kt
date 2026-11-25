package com.andrewtinyakov.messenger.infrastructure.messaging

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.infrastructure.messaging.rabbit.CommandTopology
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CommandTopologyTests {
    @Test
    fun `route uses four stable FNV partitions`() {
        assertEquals("messenger.send.0", CommandTopology.route("01ARZ3NDEKTSV4RRFFQ69G5FAV"))
        assertEquals("messenger.send.3", CommandTopology.route("01ARZ3NDEKTSV4RRFFQ69G5FAW"))
    }

    @Test
    fun `direct pair has one partition in either direction`() {
        val sender = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        val recipient = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
        assertEquals(
            CommandTopology.routeDirect(UserId(sender), UserId(recipient)),
            CommandTopology.routeDirect(UserId(recipient), UserId(sender)),
        )
        assertEquals(CommandTopology.route("$sender:$recipient"), CommandTopology.routeDirect(UserId(recipient), UserId(sender)))
    }
}
