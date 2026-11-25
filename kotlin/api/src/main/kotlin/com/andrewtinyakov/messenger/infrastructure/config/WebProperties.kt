package com.andrewtinyakov.messenger.infrastructure.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.web")
data class WebProperties(
    val cors: WebCorsProperties,
    val security: WebSecurityProperties,
)
