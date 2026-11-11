package com.andrewtinyakov.messenger.chat.grpc.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.grpc")
data class GrpcProperties(
    val enabled: Boolean = true,
    val port: Int = 9090,
    val bindAddress: String = "127.0.0.1",
    val caFile: String = "",
    val certFile: String = "",
    val keyFile: String = "",
    val allowedClientIdentity: String = "spiffe://messenger/ws",
) {
    init {
        require(port in 0..65535)
        require(bindAddress.isNotBlank())
        require(allowedClientIdentity.isNotBlank())
        if (enabled) {
            require(caFile.isNotBlank())
            require(certFile.isNotBlank())
            require(keyFile.isNotBlank())
        }
    }
}
