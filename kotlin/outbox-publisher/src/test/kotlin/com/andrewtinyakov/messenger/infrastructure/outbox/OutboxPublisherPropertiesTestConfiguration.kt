package com.andrewtinyakov.messenger.infrastructure.outbox

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(OutboxPublisherProperties::class)
class OutboxPublisherPropertiesTestConfiguration
