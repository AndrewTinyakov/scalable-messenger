package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.read.model.ReadCleanup
import com.andrewtinyakov.messenger.read.repository.ReadRepository
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime

@Service
class ReadCleanupService(
    private val repository: ReadRepository,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: ReadMetrics,
) {
    @Scheduled(
        fixedDelayString = "\${messenger.read.cleanup-delay-ms:1000}",
        initialDelayString = "\${messenger.read.cleanup-initial-delay-ms:10000}",
    )
    fun scheduledCleanup() {
        cleanup()
    }

    fun cleanup(limit: Int = 500): ReadCleanup? {
        val started = System.nanoTime()
        try {
            val now = OffsetDateTime.now(clock)
            val result = tx.observedExecute(DatabaseTransaction.READ_CLEANUP) { repository.cleanup(now, limit) }
            if (result == null) {
                metrics.count("cleanup.batches", "busy")
            } else {
                metrics.count("cleanup.batches", "completed")
                metrics.count("cleanup.rows", "ranges", result.ranges)
                metrics.count("cleanup.rows", "notifications", result.notifications)
                metrics.cleanup(result.backlog, result.oldestExpiredAt?.let { Duration.between(it, now).seconds } ?: 0)
            }
            return result
        } catch (failure: Exception) {
            metrics.count("cleanup.batches", "failed")
            throw failure
        } finally {
            metrics.duration("cleanup", started)
        }
    }
}
