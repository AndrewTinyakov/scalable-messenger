package com.andrewtinyakov.messenger.chat.grpc.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties("messenger.grpc")
data class GrpcProperties(
    val enabled: Boolean = true,
    val port: Int = 9090,
    val bindAddress: String = "127.0.0.1",
    val caFile: String = "",
    val certFile: String = "",
    val keyFile: String = "",
    val allowedClientIdentity: String = "spiffe://messenger/ws",
    val maxInboundMessageBytes: Int = 8192,
    val shutdownTimeout: Duration = Duration.ofSeconds(5),
) {
    init {
        require(port in 0..65535) { "gRPC port must be between 0 and 65535" }
        require(bindAddress.isNotBlank()) { "gRPC bind address must be set" }
        require(allowedClientIdentity.isNotBlank()) { "Allowed gRPC client identity must be set" }
        require(maxInboundMessageBytes > 0) { "gRPC maximum inbound message size must be positive" }
        require(shutdownTimeout.isPositive) { "gRPC shutdown timeout must be positive" }
        if (enabled) {
            require(caFile.isNotBlank()) { "gRPC CA file must be set when gRPC is enabled" }
            require(certFile.isNotBlank()) { "gRPC certificate file must be set when gRPC is enabled" }
            require(keyFile.isNotBlank()) { "gRPC key file must be set when gRPC is enabled" }
        }
    }
}
