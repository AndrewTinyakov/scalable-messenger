package com.andrewtinyakov.messenger.message.change

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Component
class MessageChangeRetention(
    private val repository: MessageChangeRepository,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: MeterRegistry,
) {
    @Scheduled(fixedDelayString = "\${messenger.message-changes.cleanup-delay-ms:60000}")
    fun clean() {
        val removed = tx.observedExecute(DatabaseTransaction.MESSAGE_CHANGE_RETENTION) {
            repository.prune(OffsetDateTime.now(clock).minusDays(7), 1000)
        }
        metrics.counter("messenger.message.changes.pruned").increment(removed.toDouble())
    }
}
