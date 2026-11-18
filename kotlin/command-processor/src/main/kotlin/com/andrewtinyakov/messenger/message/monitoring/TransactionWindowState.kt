package com.andrewtinyakov.messenger.message.monitoring

internal sealed interface TransactionWindowState {
    data class Executing(
        val locked: Long? = null,
    ) : TransactionWindowState

    data class CallbackFinished(
        val locked: Long?,
        val finished: Long,
    ) : TransactionWindowState

    data object Observed : TransactionWindowState
}
