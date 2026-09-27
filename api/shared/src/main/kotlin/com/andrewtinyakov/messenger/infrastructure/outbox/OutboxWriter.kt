package com.andrewtinyakov.messenger.infrastructure.outbox

import org.springframework.stereotype.Service

@Service
class OutboxWriter(
    private val repository: OutboxRepository,
) {
    fun enqueue(eventId: String, room: String, payload: String) = enqueue(listOf(OutboxMessage(eventId, room, payload)))

    fun enqueue(messages: Collection<OutboxMessage>) = repository.enqueue(messages)
}
