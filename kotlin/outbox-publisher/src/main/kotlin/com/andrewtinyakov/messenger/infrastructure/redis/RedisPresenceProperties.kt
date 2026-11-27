package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * The gateways' presence Redis, set the same way as theirs: PRESENCE_REDIS_URL and PRESENCE_REDIS_CLUSTER_NODES.
 * Both unset means the room Redis. The password applies when the URL carries none.
 */
@ConfigurationProperties("messenger.redis.presence")
data class RedisPresenceProperties(
    val url: String = "",
    val clusterNodes: List<String> = emptyList(),
    val password: String = "",
)
