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
    @Volatile
    private var state: ServerState = ServerState.Stopped

    internal val boundPort: Int
        get() = when (val current = state) {
            ServerState.Stopped -> error("Authorization server is stopped")
            is ServerState.Running -> current.server.port
            is ServerState.Stopping -> current.server.port
        }

    @Synchronized
    override fun start() {
        if (state != ServerState.Stopped) return
        val tls = GrpcSslContexts.forServer(File(properties.certFile), File(properties.keyFile))
            .trustManager(File(properties.caFile))
            .clientAuth(ClientAuth.REQUIRE)
            .build()
        val server = NettyServerBuilder.forAddress(InetSocketAddress(properties.bindAddress, properties.port))
            .sslContext(tls)
            .intercept(GrpcClientIdentityInterceptor(properties.allowedClientIdentity))
            .maxInboundMessageSize(properties.maxInboundMessageBytes)
            .addService(chatAuthorizationGrpcService)
            .build().start()
        state = ServerState.Running(server)
    }

    @Synchronized
    override fun stop() {
        val stopping = when (val current = state) {
            ServerState.Stopped -> return
            is ServerState.Running -> current.server.also { state = ServerState.Stopping(it) }
            is ServerState.Stopping -> current.server
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
            if (stopping.isTerminated) state = ServerState.Stopped
        }
    }

    override fun isRunning(): Boolean = state is ServerState.Running

    private sealed interface ServerState {
        data object Stopped : ServerState

        data class Running(
            val server: Server,
        ) : ServerState

        data class Stopping(
            val server: Server,
        ) : ServerState
    }
}
