package com.andrewtinyakov.messenger.infrastructure.database

internal class QueryState(
    val operation: DatabaseOperation,
) {
    val started = System.nanoTime()
    var statementStarted: Long? = null
    var fetchStarted: Long? = null
    var failed = false
}
