package com.andrewtinyakov.messenger.infrastructure.grpc

import com.andrewtinyakov.messenger.ws.grpc.ChatAuthorizationGrpcService
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder
import io.grpc.netty.shaded.io.netty.handler.ssl.ClientAuth
import io.micrometer.core.instrument.binder.grpc.ObservationGrpcServerInterceptor
import io.micrometer.observation.ObservationRegistry
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
    private val observations: ObservationRegistry,
) : SmartLifecycle {
    @Volatile
    private var state: GrpcServerState = GrpcServerState.Stopped

    internal val boundPort: Int
        get() = when (val current = state) {
            GrpcServerState.Stopped -> error("Authorization server is stopped")
            is GrpcServerState.Running -> current.server.port
            is GrpcServerState.Stopping -> current.server.port
        }

    @Synchronized
    override fun start() {
        if (state != GrpcServerState.Stopped) return
        val tls = GrpcSslContexts.forServer(File(properties.certFile), File(properties.keyFile))
            .trustManager(File(properties.caFile))
            .clientAuth(ClientAuth.REQUIRE)
            .build()
        val server = NettyServerBuilder.forAddress(InetSocketAddress(properties.bindAddress, properties.port))
            .sslContext(tls)
            .intercept(GrpcClientIdentityInterceptor(properties.allowedClientIdentity))
            .intercept(ObservationGrpcServerInterceptor(observations))
            .maxInboundMessageSize(properties.maxInboundMessageBytes)
            .addService(chatAuthorizationGrpcService)
            .build().start()
        state = GrpcServerState.Running(server)
    }

    @Synchronized
    override fun stop() {
        val stopping = when (val current = state) {
            GrpcServerState.Stopped -> return
            is GrpcServerState.Running -> current.server.also { state = GrpcServerState.Stopping(it) }
            is GrpcServerState.Stopping -> current.server
        }
        stopping.shutdown()
        try {
            if (!stopping.awaitTermination(properties.shutdownTimeout.toNanos(), TimeUnit.NANOSECONDS)) {
                stopping.shutdownNow()
                check(stopping.awaitTermination(properties.shutdownTimeout.toNanos(), TimeUnit.NANOSECONDS)) {
                    "Authorization server did not terminate"
                }
            }
        } catch (error: InterruptedException) {
            stopping.shutdownNow()
            try {
                check(stopping.awaitTermination(properties.shutdownTimeout.toNanos(), TimeUnit.NANOSECONDS)) {
                    "Authorization server did not terminate"
                }
            } catch (terminationError: Exception) {
                error.addSuppressed(terminationError)
            } finally {
                Thread.currentThread().interrupt()
            }
            throw error
        } finally {
            if (stopping.isTerminated) state = GrpcServerState.Stopped
        }
    }

    override fun isRunning(): Boolean = state is GrpcServerState.Running
}
