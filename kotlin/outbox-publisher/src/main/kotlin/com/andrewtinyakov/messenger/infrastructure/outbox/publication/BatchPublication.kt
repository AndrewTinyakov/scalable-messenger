package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxBatchOutcome

internal data class BatchPublication(
    val completed: Int,
    val outcome: OutboxBatchOutcome,
)
