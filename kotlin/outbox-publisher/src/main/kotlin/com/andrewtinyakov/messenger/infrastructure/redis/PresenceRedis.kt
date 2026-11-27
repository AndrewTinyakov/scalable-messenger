package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

/** The gateways' presence Redis. Unset means the room Redis, as in the gateway. */
@ConfigurationProperties("messenger.redis.presence")
data class RedisPresenceProperties(
    val url: String = "",
)

/** Where presence revocations are published: the Redis whose presence channels the gateways subscribe to. */
class PresenceRedis private constructor(
    val template: ReactiveStringRedisTemplate,
    private val connections: LettuceConnectionFactory?,
) : AutoCloseable {
    override fun close() {
        connections?.destroy()
    }

    companion object {
        fun of(properties: RedisPresenceProperties, rooms: ReactiveStringRedisTemplate): PresenceRedis {
            if (properties.url.isBlank()) return PresenceRedis(rooms, null)
            val connections = LettuceConnectionFactory(LettuceConnectionFactory.createRedisConfiguration(properties.url))
            connections.afterPropertiesSet()
            connections.start()
            return PresenceRedis(ReactiveStringRedisTemplate(connections), connections)
        }
    }
}
