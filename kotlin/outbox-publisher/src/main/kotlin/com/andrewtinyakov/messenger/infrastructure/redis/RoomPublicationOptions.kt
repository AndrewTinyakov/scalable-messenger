package com.andrewtinyakov.messenger.infrastructure.redis

import java.util.UUID

internal data class RoomPublicationOptions(
    val version: Int,
    val room: String,
    val eventId: String,
    val epoch: UUID,
    val historyMaxLength: Int,
    val historyMaxBytes: Int,
    val historySeconds: Int,
    val idleTtlSeconds: Int,
    val groupPublicationOrder: String?,
)
