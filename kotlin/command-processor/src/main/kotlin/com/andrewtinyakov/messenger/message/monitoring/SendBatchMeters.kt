package com.andrewtinyakov.messenger.message.monitoring

import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.Timer

internal data class SendBatchMeters(
    val transaction: Timer,
    val completion: Timer,
    val size: DistributionSummary,
)
