package com.andrewtinyakov.messenger.infrastructure.redis

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.mockito.Mockito.mock
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory
import org.springframework.data.redis.connection.RedisClusterConfiguration
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

class PresenceRedisTests {
    private val room = RedisPresenceProperties(roomClusterNodes = listOf("redis-1:6379", "redis-2:6379"), roomPassword = "room")

    @Test
    fun `presence revocations use the room Redis unless a presence Redis is set`() {
        val rooms = ReactiveStringRedisTemplate(mock(ReactiveRedisConnectionFactory::class.java))
        assertSame(rooms, PresenceRedis.of(room.copy(clusterNodes = listOf("")), rooms).template)
    }

    @Test
    fun `presence nodes alone keep the room credentials`() {
        val server = PresenceRedis.server(room, listOf("presence-1:6379")) as RedisClusterConfiguration
        assertEquals(setOf("presence-1:6379"), server.clusterNodes.map { "${it.host}:${it.port}" }.toSet())
        assertEquals("room", String(server.password.get()))
    }

    @Test
    fun `a presence URL alone keeps the room nodes, as in the gateway`() {
        val server = PresenceRedis.server(room.copy(url = "redis://:presence@presence:6379/0"), emptyList()) as RedisClusterConfiguration
        assertEquals(2, server.clusterNodes.size)
        assertEquals("presence", String(server.password.get()))
    }

    @Test
    fun `a standalone presence URL keeps its user, its password once decoded and its database`() {
        val standalone = room.copy(roomClusterNodes = emptyList())
        val server = PresenceRedis.server(standalone.copy(url = "redis://alice:a%2Bb@presence:6380/?db=3"), emptyList())
            as RedisStandaloneConfiguration
        assertEquals("alice", server.username)
        assertEquals("a+b", String(server.password.get()))
        assertEquals(6380, server.port)
        assertEquals(3, server.database)
    }

    @Test
    fun `a presence URL without credentials does not take the room's`() {
        val standalone = room.copy(roomClusterNodes = emptyList(), roomUsername = "room-user")
        val server = PresenceRedis.server(
            standalone.copy(url = "redis://presence:6379/16?db=3"),
            emptyList(),
        ) as RedisStandaloneConfiguration
        assertEquals(null, server.username)
        assertEquals(false, server.password.isPresent)
        assertEquals(3, server.database)
    }

    @Test
    fun `presence nodes alone keep the room user`() {
        val server = PresenceRedis.server(room.copy(roomUsername = "room-user"), listOf("presence-1:6379")) as RedisClusterConfiguration
        assertEquals("room-user", server.username)
    }

    @Test
    fun `a blank cluster entry is rejected, as in the gateway`() {
        assertThrows<IllegalArgumentException> {
            PresenceRedis.of(
                room.copy(clusterNodes = listOf("presence-1:6379", " ")),
                ReactiveStringRedisTemplate(mock(ReactiveRedisConnectionFactory::class.java)),
            )
        }
    }
}
