package com.andrewtinyakov.messenger.infrastructure.database

import org.springframework.transaction.TransactionStatus
import org.springframework.transaction.support.TransactionTemplate

object DatabaseObservation {
    @PublishedApi
    internal val queryOperation = ThreadLocal<DatabaseOperation>()

    @PublishedApi
    internal val transactionOperation = ThreadLocal<DatabaseTransaction>()

    inline fun <T> query(operation: DatabaseOperation, action: () -> T): T {
        val previous = queryOperation.get()
        queryOperation.set(operation)
        try {
            return action()
        } finally {
            if (previous == null) queryOperation.remove() else queryOperation.set(previous)
        }
    }

    inline fun <T> transaction(operation: DatabaseTransaction, action: () -> T): T {
        val previous = transactionOperation.get()
        transactionOperation.set(operation)
        try {
            return action()
        } finally {
            if (previous == null) transactionOperation.remove() else transactionOperation.set(previous)
        }
    }
}

fun <T> TransactionTemplate.observedExecute(operation: DatabaseTransaction, action: (TransactionStatus) -> T): T =
    DatabaseObservation.transaction(operation) { execute(action) }

fun TransactionTemplate.observedExecuteWithoutResult(operation: DatabaseTransaction, action: (TransactionStatus) -> Unit) {
    DatabaseObservation.transaction(operation) { executeWithoutResult(action) }
}
