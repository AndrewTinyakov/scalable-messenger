package com.andrewtinyakov.messenger.infrastructure.redis

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RedisRoomProperties::class)
class RedisConfig
