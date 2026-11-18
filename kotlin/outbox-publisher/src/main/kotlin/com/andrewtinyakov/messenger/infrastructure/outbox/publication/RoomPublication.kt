package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.metrics.OutboxStageOutcome

internal data class RoomPublication(
    val published: List<EventId>,
    val outcome: OutboxStageOutcome,
)
