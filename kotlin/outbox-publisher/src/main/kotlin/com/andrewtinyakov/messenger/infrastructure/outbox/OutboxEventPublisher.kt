package com.andrewtinyakov.messenger.infrastructure.outbox

fun interface OutboxEventPublisher {
    fun publish(message: OutboxMessage)
}
