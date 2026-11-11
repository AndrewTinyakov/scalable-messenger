package com.andrewtinyakov.messenger.message.change.service

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.message.change.config.MessageChangeRetentionProperties
import com.andrewtinyakov.messenger.message.change.repository.MessageChangeRepository
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageChangeRetentionService(
    private val messageChangeRepository: MessageChangeRepository,
    private val properties: MessageChangeRetentionProperties,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: MessageMetrics,
) {
    fun pruneExpiredChanges() {
        val removed = tx.observedExecute(DatabaseTransaction.MESSAGE_CHANGE_RETENTION) {
            messageChangeRepository.prune(OffsetDateTime.now(clock).minus(properties.retention), properties.pruneBatchSize)
        }
        metrics.changesPruned(removed)
    }
}
