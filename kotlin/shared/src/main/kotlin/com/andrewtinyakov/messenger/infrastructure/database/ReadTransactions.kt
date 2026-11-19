package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.DSLContext
import org.springframework.stereotype.Component
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

@Component
class ReadTransactions(
    transactionManager: PlatformTransactionManager,
    private val db: DSLContext,
) {
    private val readOnly = TransactionTemplate(transactionManager).apply { isReadOnly = true }

    fun <T> primary(snapshot: Boolean = false, block: () -> T): T = read(snapshot, block)

    @Suppress("UNCHECKED_CAST")
    private fun <T> read(snapshot: Boolean, block: () -> T): T = readOnly.execute {
        if (snapshot) db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        block()
    } as T
}
