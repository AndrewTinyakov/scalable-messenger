package com.andrewtinyakov.messenger.message.change

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageChangeRetentionService(
    private val repository: MessageChangeRepository,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: MessageMetrics,
) {
    fun pruneExpiredChanges() {
        val removed = tx.observedExecute(DatabaseTransaction.MESSAGE_CHANGE_RETENTION) {
            repository.prune(OffsetDateTime.now(clock).minusDays(7), 1000)
        }
        metrics.changesPruned(removed)
    }
}
