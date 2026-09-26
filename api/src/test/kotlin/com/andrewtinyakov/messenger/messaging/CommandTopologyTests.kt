package com.andrewtinyakov.messenger.messaging

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CommandTopologyTests {
    @Test
    fun `route uses four stable FNV partitions`() {
        assertEquals("messenger.send.0", CommandTopology.route("01ARZ3NDEKTSV4RRFFQ69G5FAV"))
        assertEquals("messenger.send.3", CommandTopology.route("01ARZ3NDEKTSV4RRFFQ69G5FAW"))
    }
}
