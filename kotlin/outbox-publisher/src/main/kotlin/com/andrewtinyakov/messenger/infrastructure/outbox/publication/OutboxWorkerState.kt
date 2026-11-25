package com.andrewtinyakov.messenger.infrastructure.outbox.publication

internal sealed interface OutboxWorkerState {
    data object Stopped : OutboxWorkerState

    data class Running(
        val thread: Thread,
    ) : OutboxWorkerState

    data class Stopping(
        val thread: Thread,
    ) : OutboxWorkerState
}
