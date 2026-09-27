package com.andrewtinyakov.messenger.infrastructure.outbox

import java.time.OffsetDateTime

interface OutboxRepository {
    fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<OutboxMessage>

    fun complete(ids: Collection<String>, owner: String)

    fun enqueue(messages: Collection<OutboxMessage>)
}
