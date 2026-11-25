package com.andrewtinyakov.messenger.infrastructure.database

import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.TransactionSystemException
import org.springframework.transaction.support.AbstractPlatformTransactionManager
import org.springframework.transaction.support.DefaultTransactionStatus

internal class FailingTransactionManager(
    var failure: String?,
) : AbstractPlatformTransactionManager() {
    override fun doGetTransaction(): Any = Any()

    override fun doBegin(transaction: Any, definition: TransactionDefinition) = fail("begin")

    override fun doCommit(status: DefaultTransactionStatus) = fail("commit")

    override fun doRollback(status: DefaultTransactionStatus) = fail("rollback")

    private fun fail(phase: String) {
        if (failure == phase) throw TransactionSystemException("controlled $phase failure")
    }
}
