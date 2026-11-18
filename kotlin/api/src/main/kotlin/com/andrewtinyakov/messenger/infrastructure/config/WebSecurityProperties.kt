package com.andrewtinyakov.messenger.infrastructure.config

data class WebSecurityProperties(
    val preflightPaths: List<String> = emptyList(),
    val publicPaths: List<String> = emptyList(),
    val monitoringPaths: List<String> = emptyList(),
    val deniedPaths: List<String> = emptyList(),
) {
    init {
        require((preflightPaths + publicPaths + monitoringPaths + deniedPaths).all { it.startsWith('/') })
    }
}
