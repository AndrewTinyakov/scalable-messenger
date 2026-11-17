package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecute
import com.andrewtinyakov.messenger.message.config.MessageChangeRetentionProperties
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import com.andrewtinyakov.messenger.message.repository.MessageChangeRepository
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
