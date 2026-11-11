package com.andrewtinyakov.messenger.infrastructure.outbox.repository

import com.andrewtinyakov.messenger.infrastructure.outbox.model.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxBacklog
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import java.time.OffsetDateTime

interface OutboxClaimRepository {
    fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<OutboxMessage>

    fun claimGroupTail(
        anchor: OutboxMessage,
        now: OffsetDateTime,
        limit: Int,
        owner: String,
        leaseUntil: OffsetDateTime,
    ): List<OutboxMessage>

    fun complete(ids: Collection<EventId>, owner: String)

    fun backlog(): OutboxBacklog
}
