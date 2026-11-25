package com.andrewtinyakov.messenger.infrastructure.outbox

import java.time.OffsetDateTime

data class OutboxMessage(
    val id: EventId,
    val room: String,
    val payload: String,
    val groupPublicationOrder: Long? = null,
    val createdAt: OffsetDateTime? = null,
    val replayPayload: String? = null,
    /** Chat-list activity for a group message, built while hydrating. Published live only, never stored. */
    val activityPayload: String? = null,
)
