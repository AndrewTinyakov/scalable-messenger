package com.andrewtinyakov.messenger.message.monitoring

import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager

internal enum class SendTransactionCompletion(
    val stage: SendStage,
    val batchOutcome: SendBatchOutcome,
) {
    COMMITTED(SendStage.TRANSACTION_COMMITTED, SendBatchOutcome.COMMITTED),
    ROLLED_BACK(SendStage.TRANSACTION_ROLLED_BACK, SendBatchOutcome.ROLLED_BACK),
    UNKNOWN(SendStage.TRANSACTION_UNKNOWN, SendBatchOutcome.UNKNOWN),
    ;

    companion object {
        fun from(status: Int): SendTransactionCompletion = when (status) {
            TransactionSynchronization.STATUS_COMMITTED -> COMMITTED
            TransactionSynchronization.STATUS_ROLLED_BACK -> ROLLED_BACK
            else -> UNKNOWN
        }

        fun onCompletion(action: (SendTransactionCompletion) -> Unit) {
            TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
                override fun afterCompletion(status: Int) = action(from(status))
            })
        }
    }
}
