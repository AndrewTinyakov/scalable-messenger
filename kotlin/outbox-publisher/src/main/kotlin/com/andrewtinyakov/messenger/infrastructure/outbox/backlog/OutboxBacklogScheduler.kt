package com.andrewtinyakov.messenger.infrastructure.outbox.backlog

import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class OutboxBacklogScheduler(
    private val outboxBacklogService: OutboxBacklogService,
) {
    @Scheduled(fixedDelay = 15000)
    fun runBacklogSample() = outboxBacklogService.sampleBacklog()
}
