package com.andrewtinyakov.messenger.infrastructure.redis.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.redis.room")
data class RedisRoomProperties(
    val historyMaxLength: Int = 30000,
    val historyMaxBytes: Int = 32 * 1024 * 1024,
    val historySeconds: Int = 300,
    val idleTtlSeconds: Int = 3600,
) {
    init {
        require(historyMaxLength in 1..100000)
        require(historyMaxBytes in 65536..268435456)
        require(historySeconds in 1..86400)
        require(idleTtlSeconds in 60..604800)
    }
}
