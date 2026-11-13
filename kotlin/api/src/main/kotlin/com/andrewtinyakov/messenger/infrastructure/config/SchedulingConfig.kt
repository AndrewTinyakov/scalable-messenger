package com.andrewtinyakov.messenger.infrastructure.config

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.annotation.EnableScheduling

@Configuration
@EnableScheduling
@ConditionalOnProperty(name = ["messenger.scheduling.enabled"], matchIfMissing = true)
class SchedulingConfig
