package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.outbox.backlog.OutboxBacklog
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
