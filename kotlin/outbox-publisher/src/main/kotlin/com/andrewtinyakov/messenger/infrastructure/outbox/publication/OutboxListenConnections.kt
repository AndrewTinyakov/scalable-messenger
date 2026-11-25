package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import java.sql.Connection

fun interface OutboxListenConnections {
    fun open(): Connection
}
