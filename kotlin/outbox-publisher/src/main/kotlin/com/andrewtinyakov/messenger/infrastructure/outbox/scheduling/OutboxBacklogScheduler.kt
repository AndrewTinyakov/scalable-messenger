package com.andrewtinyakov.messenger.infrastructure.outbox.scheduling

import com.andrewtinyakov.messenger.infrastructure.outbox.service.OutboxBacklogService
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class OutboxBacklogScheduler(
    private val outboxBacklogService: OutboxBacklogService,
) {
    @Scheduled(fixedDelay = 15000)
    fun runBacklogSample() = outboxBacklogService.sampleBacklog()
}
