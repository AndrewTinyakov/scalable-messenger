package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.SendTarget
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics.BatchOutcome
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import java.time.Duration

@Service
class MessageSendBatchService(
    private val service: MessageSendService,
    private val tx: TransactionTemplate,
    private val metrics: MessageSendMetrics,
) {
    fun process(commands: List<SendMessageCommandV1>): List<CommandResult> {
        require(commands.size in 1..MAX_BATCH_SIZE) { "Send batch size must be between 1 and $MAX_BATCH_SIZE" }
        require(commands.map(SendTarget::from).distinct().size == 1) { "A send batch must share one target" }
        check(!TransactionSynchronizationManager.isActualTransactionActive()) { "Send batch must own its transaction" }
        val started = System.nanoTime()
        var callbackFinished = started
        val results = tx.observedExecute(DatabaseTransaction.SEND_BATCH) {
            TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
                override fun afterCompletion(status: Int) {
                    val outcome = when (status) {
                        TransactionSynchronization.STATUS_COMMITTED -> BatchOutcome.COMMITTED
                        TransactionSynchronization.STATUS_ROLLED_BACK -> BatchOutcome.ROLLED_BACK
                        else -> BatchOutcome.UNKNOWN
                    }
                    val stage = when (status) {
                        TransactionSynchronization.STATUS_COMMITTED -> SendStage.TRANSACTION_COMMITTED
                        TransactionSynchronization.STATUS_ROLLED_BACK -> SendStage.TRANSACTION_ROLLED_BACK
                        else -> SendStage.TRANSACTION_UNKNOWN
                    }
                    SendStageRecorder.requests(stage, commands) { it.requestId }
                    val finished = System.nanoTime()
                    metrics.batchCompleted(
                        size = commands.size,
                        outcome = outcome,
                        transactionDuration = Duration.ofNanos(finished - started),
                        completionDuration = Duration.ofNanos(finished - callbackFinished),
                    )
                }
            })
            try {
                service.processBatchInTransaction(commands)
            } finally {
                callbackFinished = System.nanoTime()
                SendStageRecorder.requests(SendStage.TRANSACTION_CALLBACK_FINISHED, commands) { it.requestId }
            }
        }
        results.forEach(metrics::commandCompleted)
        return results
    }

    companion object {
        const val MAX_BATCH_SIZE = 16
    }
}
