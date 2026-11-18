package com.andrewtinyakov.messenger.infrastructure.database

internal class TransactionState(
    val operation: DatabaseTransaction,
) {
    val started = System.nanoTime()
    var phase: TransactionPhase = TransactionPhase.Beginning
}
