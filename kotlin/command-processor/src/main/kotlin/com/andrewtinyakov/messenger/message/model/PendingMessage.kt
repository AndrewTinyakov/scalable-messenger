package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage

internal data class PendingMessage(
    val saved: SavedMessage,
    val events: List<OutboxMessage>,
)
