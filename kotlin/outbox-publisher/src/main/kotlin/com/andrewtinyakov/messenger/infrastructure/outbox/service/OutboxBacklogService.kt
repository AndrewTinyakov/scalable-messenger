package com.andrewtinyakov.messenger.infrastructure.outbox.service

import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxClaimRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

@Service
class OutboxBacklogService(
    private val repository: OutboxClaimRepository,
    private val metrics: OutboxMetrics,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    fun sampleBacklog() {
        try {
            val backlog = repository.backlog()
            metrics.backlogSampled(backlog.pending, backlog.oldestCreatedAt)
        } catch (error: Exception) {
            metrics.backlogSampleFailed()
            log.warn("Could not sample outbox backlog", error)
        }
    }
}
