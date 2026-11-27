package com.andrewtinyakov.messenger.infrastructure.redis

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

class PresenceBucketsTests {
    @Test
    fun `buckets match the gateway's`() {
        // Values from roomname.PresenceBucketOf in the gateway.
        assertEquals(4005, PresenceBuckets.of("01ARZ3NDEKTSV4RRFFQ69G5FA1"))
        assertEquals(3904, PresenceBuckets.of("01J00000000000000000000000"))
        assertEquals(135, PresenceBuckets.of("x"))
    }

    @Test
    fun `presence revocations use the room Redis unless a presence Redis is set`() {
        val rooms = ReactiveStringRedisTemplate(mock(ReactiveRedisConnectionFactory::class.java))
        assertSame(rooms, PresenceRedis.of(RedisPresenceProperties(), rooms).template)
    }
}
