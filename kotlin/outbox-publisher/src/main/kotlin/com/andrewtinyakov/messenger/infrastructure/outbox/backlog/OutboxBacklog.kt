package com.andrewtinyakov.messenger.infrastructure.outbox.backlog

import java.time.OffsetDateTime

data class OutboxBacklog(
    val pending: Long,
    val oldestCreatedAt: OffsetDateTime?,
)
