package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.SendBatch
import com.andrewtinyakov.messenger.message.model.SendTarget
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import java.time.Duration

@Service
class MessageSendBatchService(
    private val messageSendService: MessageSendService,
    private val tx: TransactionTemplate,
    private val metrics: MessageSendMetrics,
) {
    fun process(commands: List<SendMessageCommandV1>): List<CommandResult> {
        validateBatch(commands)
        val results = processInOwnTransaction(commands)
        results.forEach(metrics::commandCompleted)
        return results
    }

    private fun validateBatch(commands: List<SendMessageCommandV1>) {
        require(commands.size in 1..SendBatch.MAX_SIZE) { "Send batch size must be between 1 and ${SendBatch.MAX_SIZE}" }
        require(commands.map { SendTarget.from(it.toSendRequest()) }.distinct().size == 1) { "A send batch must share one target" }
        check(!TransactionSynchronizationManager.isActualTransactionActive()) { "Send batch must own its transaction" }
    }

    private fun processInOwnTransaction(commands: List<SendMessageCommandV1>): List<CommandResult> {
        val started = System.nanoTime()
        var callbackFinished = started
        return tx.observedExecute(DatabaseTransaction.SEND_BATCH) {
            afterSendTransactionCompletes { completion ->
                SendStageRecorder.requests(completion.stage, commands) { it.requestId }
                val finished = System.nanoTime()
                metrics.batchCompleted(
                    size = commands.size,
                    outcome = completion.batchOutcome,
                    transactionDuration = Duration.ofNanos(finished - started),
                    completionDuration = Duration.ofNanos(finished - callbackFinished),
                )
            }
            try {
                messageSendService.processBatchInTransaction(commands)
            } finally {
                callbackFinished = System.nanoTime()
                SendStageRecorder.requests(SendStage.TRANSACTION_CALLBACK_FINISHED, commands) { it.requestId }
            }
        }
    }
}
