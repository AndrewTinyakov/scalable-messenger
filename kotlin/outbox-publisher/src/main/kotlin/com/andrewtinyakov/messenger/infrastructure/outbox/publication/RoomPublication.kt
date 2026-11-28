package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxStageOutcome

internal data class RoomPublication(
    val published: List<EventId>,
    val outcome: OutboxStageOutcome,
)
