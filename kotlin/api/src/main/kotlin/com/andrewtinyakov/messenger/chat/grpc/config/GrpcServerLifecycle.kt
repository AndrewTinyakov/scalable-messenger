package com.andrewtinyakov.messenger.chat.grpc.config

import com.andrewtinyakov.messenger.chat.grpc.service.ChatAuthorizationGrpcService
import io.grpc.Server
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder
import io.grpc.netty.shaded.io.netty.handler.ssl.ClientAuth
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.SmartLifecycle
import org.springframework.stereotype.Component
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.TimeUnit

@Component
@ConditionalOnProperty(name = ["messenger.grpc.enabled"], havingValue = "true", matchIfMissing = true)
class GrpcServerLifecycle(
    private val chatAuthorizationGrpcService: ChatAuthorizationGrpcService,
    private val properties: GrpcProperties,
) : SmartLifecycle {
    private var server: Server? = null

    internal val boundPort: Int
        get() = checkNotNull(server).port

    override fun start() {
        if (server != null) return
        val tls = GrpcSslContexts.forServer(File(properties.certFile), File(properties.keyFile))
            .trustManager(File(properties.caFile))
            .clientAuth(ClientAuth.REQUIRE)
            .build()
        server = NettyServerBuilder.forAddress(InetSocketAddress(properties.bindAddress, properties.port))
            .sslContext(tls)
            .intercept(GrpcClientIdentityInterceptor(properties.allowedClientIdentity))
            .maxInboundMessageSize(8192)
            .addService(chatAuthorizationGrpcService)
            .build().start()
    }

    override fun stop() {
        val stopping = server ?: return
        stopping.shutdown()
        try {
            if (!stopping.awaitTermination(5, TimeUnit.SECONDS)) {
                stopping.shutdownNow()
                check(stopping.awaitTermination(5, TimeUnit.SECONDS)) { "Authorization server did not terminate" }
            }
        } catch (error: InterruptedException) {
            stopping.shutdownNow()
            try {
                check(stopping.awaitTermination(5, TimeUnit.SECONDS)) { "Authorization server did not terminate" }
            } catch (terminationError: Exception) {
                error.addSuppressed(terminationError)
            } finally {
                Thread.currentThread().interrupt()
            }
            throw error
        } finally {
            if (stopping.isTerminated) server = null
        }
    }

    override fun isRunning(): Boolean = server != null
}
