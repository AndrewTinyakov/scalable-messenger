package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.redis.presence")
data class RedisPresenceProperties(
    val url: String = "",
    val clusterNodes: List<String> = emptyList(),
    val roomClusterNodes: List<String> = emptyList(),
    val roomUsername: String = "",
    val roomPassword: String = "",
    val roomSsl: Boolean = false,
)
