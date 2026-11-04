package com.andrewtinyakov.messenger.infrastructure.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.web")
data class WebProperties(
    val cors: CorsProperties,
    val security: SecurityProperties,
) {
    data class CorsProperties(
        val allowedOrigins: List<String>,
        val allowedMethods: List<String>,
        val allowedHeaders: List<String>,
        val allowCredentials: Boolean,
    ) {
        init {
            require(allowedOrigins.isNotEmpty())
            require(allowedMethods.all { it.isNotBlank() })
            require(allowedHeaders.all { it.isNotBlank() })
        }
    }

    data class SecurityProperties(
        val preflightPaths: List<String> = emptyList(),
        val publicPaths: List<String> = emptyList(),
        val monitoringPaths: List<String> = emptyList(),
        val deniedPaths: List<String> = emptyList(),
    ) {
        init {
            require((preflightPaths + publicPaths + monitoringPaths + deniedPaths).all { it.startsWith('/') })
        }
    }
}
