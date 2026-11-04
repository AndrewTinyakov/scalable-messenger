package com.andrewtinyakov.messenger.infrastructure.database.observability

import org.springframework.transaction.TransactionStatus
import org.springframework.transaction.support.TransactionTemplate

enum class DatabaseTransaction(
    val label: String,
) {
    AUTH_REGISTER("auth.register"),
    AUTH_LOGOUT("auth.logout"),
    CHAT_CREATE_GROUP("chat.create_group"),
    CHAT_ADD_MEMBERS("chat.add_members"),
    CHAT_REMOVE_MEMBER("chat.remove_member"),
    SEND_SINGLE("send.single"),
    SEND_BATCH("send.batch"),
    SEND_REJECT_EXHAUSTED("send.reject_exhausted"),
    OUTBOX_CLAIM("outbox.claim"),
    OUTBOX_COMPLETE("outbox.complete"),
    MESSAGE_MUTATE("message.mutate"),
    MESSAGE_CHANGE_RETENTION("message.change_retention"),
    CHAT_DELETE("chat.delete"),
    MESSAGE_HISTORY("message.history"),
    READ_ADVANCE("read.advance"),
    READ_CLEANUP("read.cleanup"),
    OTHER("other"),
}

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
