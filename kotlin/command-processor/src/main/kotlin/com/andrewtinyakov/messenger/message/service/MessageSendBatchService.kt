package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.SendTarget
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import java.util.concurrent.TimeUnit

@Service
class MessageSendBatchService(
    private val service: MessageSendService,
    private val tx: TransactionTemplate,
    private val metrics: MeterRegistry,
) {
    fun process(commands: List<SendMessageCommandV1>): List<CommandResult> {
        require(commands.size in 1..MAX_BATCH_SIZE) { "Send batch size must be between 1 and $MAX_BATCH_SIZE" }
        require(commands.map(SendTarget::from).distinct().size == 1) { "A send batch must share one target" }
        check(!TransactionSynchronizationManager.isActualTransactionActive()) { "Send batch must own its transaction" }
        val started = System.nanoTime()
        var callbackFinished = started
        return tx.observedExecute(DatabaseTransaction.SEND_BATCH) {
            TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
                override fun afterCompletion(status: Int) {
                    val outcome = when (status) {
                        TransactionSynchronization.STATUS_COMMITTED -> "committed"
                        TransactionSynchronization.STATUS_ROLLED_BACK -> "rolled_back"
                        else -> "unknown"
                    }
                    val stage = when (status) {
                        TransactionSynchronization.STATUS_COMMITTED -> SendStage.TRANSACTION_COMMITTED
                        TransactionSynchronization.STATUS_ROLLED_BACK -> SendStage.TRANSACTION_ROLLED_BACK
                        else -> SendStage.TRANSACTION_UNKNOWN
                    }
                    SendStageRecorder.requests(stage, commands) { it.requestId }
                    val finished = System.nanoTime()
                    Timer.builder("messenger.send.batch.transaction").tag("outcome", outcome).publishPercentileHistogram()
                        .register(metrics).record(finished - started, TimeUnit.NANOSECONDS)
                    Timer.builder("messenger.send.batch.completion").tag("outcome", outcome).publishPercentileHistogram()
                        .register(metrics).record(finished - callbackFinished, TimeUnit.NANOSECONDS)
                    DistributionSummary.builder("messenger.send.batch.size").tag("outcome", outcome)
                        .publishPercentileHistogram().maximumExpectedValue(
                            MAX_BATCH_SIZE.toDouble(),
                        ).register(metrics).record(commands.size.toDouble())
                }
            })
            try {
                service.processBatchInTransaction(commands)
            } finally {
                callbackFinished = System.nanoTime()
                SendStageRecorder.requests(SendStage.TRANSACTION_CALLBACK_FINISHED, commands) { it.requestId }
            }
        }
    }

    companion object {
        const val MAX_BATCH_SIZE = 16
    }
}
