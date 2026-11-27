package com.andrewtinyakov.messenger.infrastructure.redis

import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

class PresenceRedisTests {
    @Test
    fun `presence revocations use the room Redis unless a presence Redis is set`() {
        val rooms = ReactiveStringRedisTemplate(mock(ReactiveRedisConnectionFactory::class.java))
        assertSame(rooms, PresenceRedis.of(RedisPresenceProperties(clusterNodes = listOf("")), rooms).template)
    }
}
