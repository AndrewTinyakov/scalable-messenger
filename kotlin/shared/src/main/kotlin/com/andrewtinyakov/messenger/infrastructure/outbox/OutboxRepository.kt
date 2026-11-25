package com.andrewtinyakov.messenger.infrastructure.outbox

interface OutboxRepository {
    fun enqueue(messages: Collection<OutboxMessage>)

    fun enqueue(message: OutboxMessage) = enqueue(messages = listOf(message))
}
