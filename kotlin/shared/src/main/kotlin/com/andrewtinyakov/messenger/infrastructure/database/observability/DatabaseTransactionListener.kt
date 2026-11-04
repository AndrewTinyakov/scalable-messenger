package com.andrewtinyakov.messenger.infrastructure.database.observability

import org.springframework.transaction.TransactionExecution
import org.springframework.transaction.TransactionExecutionListener
import java.util.IdentityHashMap

class DatabaseTransactionListener(
    private val metrics: DatabaseMetrics,
) : TransactionExecutionListener {
    private val transactions = ThreadLocal<IdentityHashMap<TransactionExecution, State>>()

    override fun beforeBegin(transaction: TransactionExecution) {
        if (!transaction.isNewTransaction || transaction.isNested) return
        val states = transactions.get() ?: IdentityHashMap<TransactionExecution, State>().also(transactions::set)
        states[transaction] = State(DatabaseObservation.transactionOperation.get() ?: DatabaseTransaction.OTHER)
    }

    override fun afterBegin(transaction: TransactionExecution, beginFailure: Throwable?) {
        val state = transactions.get()?.get(transaction) ?: return
        phase(state, "begin", state.started, beginFailure)
        if (beginFailure != null) finish(transaction, "begin_failed") else state.activeStarted = System.nanoTime()
    }

    override fun beforeCommit(transaction: TransactionExecution) = beforeCompletion(transaction, "commit")

    override fun beforeRollback(transaction: TransactionExecution) = beforeCompletion(transaction, "rollback")

    override fun afterCommit(transaction: TransactionExecution, commitFailure: Throwable?) {
        afterCompletion(transaction, "commit", commitFailure, if (commitFailure == null) "committed" else "failed")
    }

    override fun afterRollback(transaction: TransactionExecution, rollbackFailure: Throwable?) {
        afterCompletion(transaction, "rollback", rollbackFailure, if (rollbackFailure == null) "rolled_back" else "failed")
    }

    private fun beforeCompletion(transaction: TransactionExecution, phase: String) {
        val state = transactions.get()?.get(transaction) ?: return
        finishActive(state)
        state.completionPhase = phase
        state.completionStarted = System.nanoTime()
    }

    private fun afterCompletion(transaction: TransactionExecution, name: String, failure: Throwable?, outcome: String) {
        val state = transactions.get()?.get(transaction) ?: return
        finishActive(state)
        state.completionStarted?.let {
            phase(state, state.completionPhase ?: name, it, failure)
        }
        finish(transaction, outcome)
    }

    private fun finishActive(state: State) {
        val started = state.activeStarted ?: return
        state.activeStarted = null
        phase(state, "active", started, null)
    }

    private fun phase(state: State, name: String, started: Long, failure: Throwable?) {
        metrics.record(
            "messenger.database.transaction.phase",
            state.operation.label,
            if (failure == null) "success" else "failure",
            System.nanoTime() - started,
            name,
        )
    }

    private fun finish(transaction: TransactionExecution, outcome: String) {
        val states = transactions.get() ?: return
        val state = states.remove(transaction) ?: return
        if (states.isEmpty()) transactions.remove()
        metrics.record("messenger.database.transaction", state.operation.label, outcome, System.nanoTime() - state.started)
    }

    private class State(
        val operation: DatabaseTransaction,
    ) {
        val started = System.nanoTime()
        var activeStarted: Long? = null
        var completionStarted: Long? = null
        var completionPhase: String? = null
    }
}
