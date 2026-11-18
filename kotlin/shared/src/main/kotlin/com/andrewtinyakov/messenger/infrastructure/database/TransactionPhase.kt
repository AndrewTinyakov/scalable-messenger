package com.andrewtinyakov.messenger.infrastructure.database

internal sealed interface TransactionPhase {
    data object Beginning : TransactionPhase

    data class Active(
        val started: Long,
    ) : TransactionPhase

    data class Completing(
        val completion: TransactionCompletionPhase,
        val started: Long,
    ) : TransactionPhase
}
