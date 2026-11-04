package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.shared.id.EventId
import java.time.OffsetDateTime

data class OutboxMessage(
    val id: EventId,
    val room: String,
    val payload: String,
    val groupPublicationOrder: Long? = null,
    val createdAt: OffsetDateTime? = null,
    val replayPayload: String? = null,
)
