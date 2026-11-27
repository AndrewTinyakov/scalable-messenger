package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.data.redis.connection.RedisClusterConfiguration
import org.springframework.data.redis.connection.RedisConfiguration
import org.springframework.data.redis.connection.RedisPassword
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import java.net.URI

private const val DEFAULT_PORT = 6379

class PresenceRedis private constructor(
    val template: ReactiveStringRedisTemplate,
    private val connections: LettuceConnectionFactory?,
) : AutoCloseable {
    override fun close() {
        connections?.destroy()
    }

    companion object {
        fun of(properties: RedisPresenceProperties, rooms: ReactiveStringRedisTemplate): PresenceRedis {
            val presenceNodes = nodes(properties.clusterNodes, "messenger.redis.presence.cluster-nodes")
            if (properties.url.isBlank() && presenceNodes.isEmpty()) return PresenceRedis(rooms, null)
            val connections = LettuceConnectionFactory(server(properties, presenceNodes), client(properties))
            connections.afterPropertiesSet()
            connections.initConnection()
            return PresenceRedis(ReactiveStringRedisTemplate(connections), connections)
        }

        internal fun server(properties: RedisPresenceProperties, presenceNodes: List<String>): RedisConfiguration {
            val uri = properties.url.takeIf { it.isNotBlank() }?.let(::URI)
            val user = if (uri != null) {
                uri.userInfo?.substringBefore(':', missingDelimiterValue = "")?.ifBlank { null }
            } else {
                properties.roomUsername.ifBlank { null }
            }
            val password = RedisPassword.of(
                if (uri != null) {
                    uri.userInfo?.substringAfter(':', missingDelimiterValue = "")?.ifBlank { null }
                } else {
                    properties.roomPassword.ifBlank { null }
                },
            )
            val nodes = presenceNodes.ifEmpty { nodes(properties.roomClusterNodes, "spring.data.redis.cluster.nodes") }
            if (nodes.isNotEmpty() || uri == null) {
                return RedisClusterConfiguration(nodes).apply {
                    username = user
                    setPassword(password)
                }
            }
            return RedisStandaloneConfiguration(uri.host, uri.port.takeIf { it > 0 } ?: DEFAULT_PORT).apply {
                database = standaloneDatabase(uri)
                username = user
                setPassword(password)
            }
        }

        private fun client(properties: RedisPresenceProperties): LettuceClientConfiguration {
            val ssl = properties.url.takeIf { it.isNotBlank() }?.let { URI(it).scheme == "rediss" } ?: properties.roomSsl
            return LettuceClientConfiguration.builder().apply { if (ssl) useSsl() }.build()
        }

        private fun standaloneDatabase(uri: URI): Int =
            uri.query?.split('&')?.firstNotNullOfOrNull { it.removePrefix("db=").takeIf { db -> db != it }?.toIntOrNull() }
                ?: uri.path.trim('/').toIntOrNull()
                ?: 0

        private fun nodes(values: List<String>, name: String): List<String> {
            if (values.all(String::isBlank)) return emptyList()
            require(values.none(String::isBlank)) { "$name contains an empty address" }
            return values.map(String::trim)
        }
    }
}
