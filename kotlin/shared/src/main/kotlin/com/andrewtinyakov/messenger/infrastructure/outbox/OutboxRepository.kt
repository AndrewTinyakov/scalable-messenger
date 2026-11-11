package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.shared.id.EventId
import java.time.OffsetDateTime

interface OutboxRepository {
    fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<OutboxMessage>

    fun claimGroupTail(
        anchor: OutboxMessage,
        now: OffsetDateTime,
        limit: Int,
        owner: String,
        leaseUntil: OffsetDateTime,
    ): List<OutboxMessage>

    fun complete(ids: Collection<EventId>, owner: String)

    fun enqueue(messages: Collection<OutboxMessage>)

    fun enqueue(eventId: EventId, room: String, payload: String) =
        enqueue(messages = listOf(OutboxMessage(id = eventId, room = room, payload = payload)))

    fun backlog(): OutboxBacklog
}
