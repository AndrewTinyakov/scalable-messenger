package com.andrewtinyakov.messenger.infrastructure.database

internal class QueryState(
    val entryPoint: EntryPoint,
) {
    val started = System.nanoTime()
    var rendered = 0
}
