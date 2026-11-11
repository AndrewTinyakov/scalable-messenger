package com.andrewtinyakov.messenger.infrastructure.outbox.repository

import com.andrewtinyakov.messenger.infrastructure.outbox.model.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage

interface OutboxRepository {
    fun enqueue(messages: Collection<OutboxMessage>)

    fun enqueue(eventId: EventId, room: String, payload: String) =
        enqueue(messages = listOf(OutboxMessage(id = eventId, room = room, payload = payload)))
}
