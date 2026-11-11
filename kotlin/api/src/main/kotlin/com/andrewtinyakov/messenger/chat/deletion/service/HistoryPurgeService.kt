package com.andrewtinyakov.messenger.chat.deletion.service

import com.andrewtinyakov.messenger.chat.deletion.monitoring.DeletionMetrics
import com.andrewtinyakov.messenger.chat.deletion.repository.HistoryPurgeRepository
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate

@Service
class HistoryPurgeService(
    private val repository: HistoryPurgeRepository,
    private val tx: TransactionTemplate,
    private val metrics: DeletionMetrics,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    fun runBatch(): Int? = metrics.timePurgeBatch {
        tx.observedExecute(DatabaseTransaction.DELETION_PURGE) { repository.purge(500) }
    }

    fun purgeDeletedHistory() {
        try {
            for (attempt in 0 until 4) {
                if (runBatch() == null) break
            }
            repeat(2) { tx.observedExecute(DatabaseTransaction.DELETION_VISIBILITY_CLEANUP) { repository.cleanupPersonal(500) } }
        } catch (error: RuntimeException) {
            log.warn("History cleanup will retry", error)
        } finally {
            val backlog = repository.backlog()
            metrics.purgeBacklog(backlog.sampledJobs, backlog.oldest)
        }
    }
}
