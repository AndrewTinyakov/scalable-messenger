package com.andrewtinyakov.messenger.chat.deletion.service

import com.andrewtinyakov.messenger.chat.deletion.config.HistoryPurgeProperties
import com.andrewtinyakov.messenger.chat.deletion.monitoring.DeletionMetrics
import com.andrewtinyakov.messenger.chat.deletion.repository.HistoryPurgeRepository
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate

@Service
class HistoryPurgeService(
    private val historyPurgeRepository: HistoryPurgeRepository,
    private val properties: HistoryPurgeProperties,
    private val tx: TransactionTemplate,
    private val metrics: DeletionMetrics,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    fun runBatch(): Int? = metrics.timePurgeBatch {
        tx.observedExecute(DatabaseTransaction.DELETION_PURGE) { historyPurgeRepository.purge(properties.batchSize) }
    }

    fun purgeDeletedHistory() {
        try {
            for (attempt in 0 until properties.maxBatchesPerRun) {
                if (runBatch() == null) break
            }
            repeat(properties.personalCleanupBatchesPerRun) {
                tx.observedExecute(DatabaseTransaction.DELETION_VISIBILITY_CLEANUP) {
                    historyPurgeRepository.cleanupPersonal(properties.personalCleanupBatchSize)
                }
            }
        } catch (error: RuntimeException) {
            logger.warn("History cleanup will retry", error)
        } finally {
            val backlog = historyPurgeRepository.backlog()
            metrics.purgeBacklog(backlog.sampledJobs, backlog.oldest)
        }
    }
}
