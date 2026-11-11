package com.andrewtinyakov.messenger.infrastructure.outbox.repository

import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage

interface OutboxRepository {
    fun enqueue(messages: Collection<OutboxMessage>)

    fun enqueue(message: OutboxMessage) = enqueue(messages = listOf(message))
}
