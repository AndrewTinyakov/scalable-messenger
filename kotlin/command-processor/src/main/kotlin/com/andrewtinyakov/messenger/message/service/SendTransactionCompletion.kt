package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics.BatchOutcome
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager

internal enum class SendTransactionCompletion(
    val stage: SendStage,
    val batchOutcome: BatchOutcome,
) {
    COMMITTED(SendStage.TRANSACTION_COMMITTED, BatchOutcome.COMMITTED),
    ROLLED_BACK(SendStage.TRANSACTION_ROLLED_BACK, BatchOutcome.ROLLED_BACK),
    UNKNOWN(SendStage.TRANSACTION_UNKNOWN, BatchOutcome.UNKNOWN),
    ;

    companion object {
        fun from(status: Int): SendTransactionCompletion = when (status) {
            TransactionSynchronization.STATUS_COMMITTED -> COMMITTED
            TransactionSynchronization.STATUS_ROLLED_BACK -> ROLLED_BACK
            else -> UNKNOWN
        }
    }
}

internal fun afterSendTransactionCompletes(action: (SendTransactionCompletion) -> Unit) {
    TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
        override fun afterCompletion(status: Int) = action(SendTransactionCompletion.from(status))
    })
}
