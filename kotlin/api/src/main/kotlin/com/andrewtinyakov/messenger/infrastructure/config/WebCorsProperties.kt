package com.andrewtinyakov.messenger.infrastructure.config

data class WebCorsProperties(
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
