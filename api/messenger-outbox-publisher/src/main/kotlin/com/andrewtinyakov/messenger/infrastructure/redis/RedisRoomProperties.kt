package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.redis.room")
data class RedisRoomProperties(
    val historyMaxLength: Int = 1000,
    val idleTtlSeconds: Int = 3600,
) {
    init {
        require(historyMaxLength in 1..100000)
        require(idleTtlSeconds in 60..604800)
    }
}
