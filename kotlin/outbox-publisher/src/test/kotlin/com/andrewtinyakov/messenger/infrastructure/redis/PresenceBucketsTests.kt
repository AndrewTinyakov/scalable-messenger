package com.andrewtinyakov.messenger.infrastructure.redis

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PresenceBucketsTests {
    @Test
    fun `buckets match the gateway's`() {
        // Values from roomname.PresenceBucketOf in the gateway.
        assertEquals(4005, PresenceBuckets.of("01ARZ3NDEKTSV4RRFFQ69G5FA1"))
        assertEquals(3904, PresenceBuckets.of("01J00000000000000000000000"))
        assertEquals(135, PresenceBuckets.of("x"))
    }
}
