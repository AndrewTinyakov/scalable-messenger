package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * The gateways' presence Redis, resolved as the gateway resolves it: PRESENCE_REDIS_URL and
 * PRESENCE_REDIS_CLUSTER_NODES, each falling back to the room Redis. A presence URL carries its own credentials,
 * database and TLS; without one they come from the room Redis. Both unset means the room Redis itself.
 */
@ConfigurationProperties("messenger.redis.presence")
data class RedisPresenceProperties(
    val url: String = "",
    val clusterNodes: List<String> = emptyList(),
    val roomClusterNodes: List<String> = emptyList(),
    val roomUsername: String = "",
    val roomPassword: String = "",
    val roomSsl: Boolean = false,
)
