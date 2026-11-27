package com.andrewtinyakov.messenger.infrastructure.outbox.backlog

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxClaimRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

@Service
class OutboxBacklogService(
    private val outboxClaimRepository: OutboxClaimRepository,
    private val metrics: OutboxMetrics,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    fun sampleBacklog() {
        try {
            val backlog = outboxClaimRepository.backlog()
            metrics.backlogSampled(backlog.pending, backlog.oldestCreatedAt)
        } catch (error: Exception) {
            metrics.backlogSampleFailed()
            logger.warn("Could not sample outbox backlog", error)
        }
    }
}
