package com.andrewtinyakov.messenger.message.messaging.listener

import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.AbstractPlatformTransactionManager
import org.springframework.transaction.support.DefaultTransactionStatus

internal class RecordingTransactions : AbstractPlatformTransactionManager() {
    var commits = 0
    var rollbacks = 0
    var commitFailure: RuntimeException? = null

    override fun doGetTransaction(): Any = Any()

    override fun doBegin(transaction: Any, definition: TransactionDefinition) {}

    override fun doCommit(status: DefaultTransactionStatus) {
        commitFailure?.let { throw it }
        commits++
    }

    override fun doRollback(status: DefaultTransactionStatus) {
        rollbacks++
    }
}
