package com.andrewtinyakov.messenger.infrastructure.database

internal class TransactionState(
    val entryPoint: EntryPoint,
) {
    val started = System.nanoTime()
    var phase: TransactionPhase = TransactionPhase.Beginning
}
