package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.read.config.ReadProperties
import com.andrewtinyakov.messenger.read.model.ReadCleanup
import com.andrewtinyakov.messenger.read.monitoring.ReadMetrics
import com.andrewtinyakov.messenger.read.repository.ReadRepository
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime

@Service
class ReadCleanupService(
    private val readRepository: ReadRepository,
    private val properties: ReadProperties,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: ReadMetrics,
) {
    fun cleanup(limit: Int = properties.cleanupBatchSize): ReadCleanup? = metrics.timeCleanup {
        val now = OffsetDateTime.now(clock)
        val result = try {
            tx.observedExecute(DatabaseTransaction.READ_CLEANUP) { readRepository.cleanup(now, limit) }
        } catch (failure: Exception) {
            metrics.cleanupFailed()
            throw failure
        }
        if (result == null) {
            metrics.cleanupBusy()
        } else {
            metrics.cleanupCompleted(result, result.oldestExpiredAt?.let { Duration.between(it, now) } ?: Duration.ZERO)
        }
        result
    }
}
