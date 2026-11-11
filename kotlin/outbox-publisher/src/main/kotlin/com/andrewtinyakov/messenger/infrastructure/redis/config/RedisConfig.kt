package com.andrewtinyakov.messenger.infrastructure.redis.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RedisRoomProperties::class)
class RedisConfig {
    @Bean
    fun reactiveStringRedisTemplate(connections: LettuceConnectionFactory): ReactiveStringRedisTemplate {
        connections.initConnection()
        return ReactiveStringRedisTemplate(connections)
    }
}
