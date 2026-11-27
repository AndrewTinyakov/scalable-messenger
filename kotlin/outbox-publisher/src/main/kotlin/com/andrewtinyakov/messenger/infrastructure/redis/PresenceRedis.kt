package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.data.redis.connection.RedisClusterConfiguration
import org.springframework.data.redis.connection.RedisConfiguration
import org.springframework.data.redis.connection.RedisPassword
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import java.net.URI
import java.net.URLDecoder

private const val DEFAULT_PORT = 6379

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
            val nodes = properties.clusterNodes.filter(String::isNotBlank)
            if (properties.url.isBlank() && nodes.isEmpty()) return PresenceRedis(rooms, null)
            val uri = URI(properties.url.ifBlank { "redis://localhost" })
            val password = RedisPassword.of(
                uri.userInfo?.substringAfter(':')?.ifBlank { null }?.let { URLDecoder.decode(it, Charsets.UTF_8) }
                    ?: properties.password.ifBlank { null },
            )
            val server: RedisConfiguration = if (nodes.isNotEmpty()) {
                RedisClusterConfiguration(nodes).apply { setPassword(password) }
            } else {
                RedisStandaloneConfiguration(uri.host, uri.port.takeIf { it > 0 } ?: DEFAULT_PORT).apply {
                    database = uri.path.trim('/').toIntOrNull() ?: 0
                    setPassword(password)
                }
            }
            val client = LettuceClientConfiguration.builder().apply { if (uri.scheme == "rediss") useSsl() }.build()
            val connections = LettuceConnectionFactory(server, client)
            connections.afterPropertiesSet()
            // Connect now, not on the first revocation inside a publication.
            connections.initConnection()
            return PresenceRedis(ReactiveStringRedisTemplate(connections), connections)
        }
    }
}
