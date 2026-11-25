package com.andrewtinyakov.messenger.infrastructure.grpc

import io.grpc.Server

internal sealed interface GrpcServerState {
    data object Stopped : GrpcServerState

    data class Running(
        val server: Server,
    ) : GrpcServerState

    data class Stopping(
        val server: Server,
    ) : GrpcServerState
}
