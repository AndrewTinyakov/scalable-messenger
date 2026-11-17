package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.redis.room")
data class RedisRoomProperties(
    val historyMaxLength: Int = 30000,
    val historyMaxBytes: Int = 32 * 1024 * 1024,
    val historySeconds: Int = 300,
    val idleTtlSeconds: Int = 3600,
) {
    init {
        require(historyMaxLength in 1..100000) { "Room history length must be between 1 and 100000 events" }
        require(historyMaxBytes in 65536..268435456) { "Room history byte limit must be between 65536 and 268435456" }
        require(historySeconds in 1..86400) { "Room history retention must be between 1 and 86400 seconds" }
        require(idleTtlSeconds in 60..604800) { "Room idle TTL must be between 60 and 604800 seconds" }
    }
}
