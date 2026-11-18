package com.andrewtinyakov.messenger.infrastructure.messaging.rabbit

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(RabbitProperties::class)
class RabbitPropertiesTestConfiguration
