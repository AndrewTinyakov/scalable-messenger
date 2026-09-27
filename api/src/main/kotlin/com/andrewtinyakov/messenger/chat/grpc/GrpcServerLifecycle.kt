package com.andrewtinyakov.messenger.chat.grpc

import io.grpc.Server
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.SmartLifecycle
import org.springframework.stereotype.Component
import java.util.concurrent.TimeUnit

@Component
@ConditionalOnProperty(name = ["messenger.grpc.enabled"], havingValue = "true", matchIfMissing = true)
class GrpcServerLifecycle(
    private val authorization: ChatAuthorizationGrpcService,
    @Value("\${messenger.grpc.port:9090}") private val port: Int,
) : SmartLifecycle {
    private var server: Server? = null

    override fun start() {
        if (server != null) return
        server = NettyServerBuilder.forPort(port).addService(authorization).build().start()
    }

    override fun stop() {
        server?.shutdown()?.awaitTermination(5, TimeUnit.SECONDS)
        server = null
    }

    override fun isRunning(): Boolean = server != null
}
