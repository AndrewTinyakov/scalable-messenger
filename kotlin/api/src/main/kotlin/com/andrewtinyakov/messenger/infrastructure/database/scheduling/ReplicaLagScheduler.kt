package com.andrewtinyakov.messenger.infrastructure.database.scheduling

import com.andrewtinyakov.messenger.infrastructure.database.ReplicaLagMonitor
import org.springframework.scheduling.annotation.Scheduled

class ReplicaLagScheduler(
    private val lag: ReplicaLagMonitor,
) {
    @Scheduled(fixedDelayString = $$"${messenger.database.replica.check-interval:1s}")
    fun sampleLag() = lag.check()
}
