package com.andrewtinyakov.messenger.infrastructure.database

import org.springframework.transaction.TransactionExecution
import org.springframework.transaction.TransactionExecutionListener
import java.util.IdentityHashMap

class DatabaseTransactionListener(
    private val metrics: DatabaseMetrics,
) : TransactionExecutionListener {
    private val transactions = ThreadLocal<IdentityHashMap<TransactionExecution, TransactionState>>()

    override fun beforeBegin(transaction: TransactionExecution) {
        if (!transaction.isNewTransaction || transaction.isNested) return
        val states = transactions.get() ?: IdentityHashMap<TransactionExecution, TransactionState>().also(transactions::set)
        states[transaction] = TransactionState(DatabaseObservation.transactionOperation.get() ?: DatabaseTransaction.OTHER)
    }

    override fun afterBegin(transaction: TransactionExecution, beginFailure: Throwable?) {
        val state = transactions.get()?.get(transaction) ?: return
        phase(state, "begin", state.started, beginFailure)
        if (beginFailure != null) finish(transaction, "begin_failed") else state.phase = TransactionPhase.Active(System.nanoTime())
    }

    override fun beforeCommit(transaction: TransactionExecution) = beforeCompletion(transaction, TransactionCompletionPhase.COMMIT)

    override fun beforeRollback(transaction: TransactionExecution) = beforeCompletion(transaction, TransactionCompletionPhase.ROLLBACK)

    override fun afterCommit(transaction: TransactionExecution, commitFailure: Throwable?) {
        afterCompletion(transaction, commitFailure, if (commitFailure == null) "committed" else "failed")
    }

    override fun afterRollback(transaction: TransactionExecution, rollbackFailure: Throwable?) {
        afterCompletion(transaction, rollbackFailure, if (rollbackFailure == null) "rolled_back" else "failed")
    }

    private fun beforeCompletion(transaction: TransactionExecution, completion: TransactionCompletionPhase) {
        val state = transactions.get()?.get(transaction) ?: return
        val active = state.phase as? TransactionPhase.Active
        active?.let { phase(state, "active", it.started, null) }
        state.phase = TransactionPhase.Completing(completion, System.nanoTime())
    }

    private fun afterCompletion(transaction: TransactionExecution, failure: Throwable?, outcome: String) {
        val state = transactions.get()?.get(transaction) ?: return
        when (val current = state.phase) {
            TransactionPhase.Beginning -> Unit
            is TransactionPhase.Active -> phase(state, "active", current.started, null)
            is TransactionPhase.Completing -> phase(state, current.completion.metricValue, current.started, failure)
        }
        finish(transaction, outcome)
    }

    private fun phase(state: TransactionState, name: String, started: Long, failure: Throwable?) {
        metrics.record(
            "messenger.database.transaction.phase",
            state.operation.metricValue,
            if (failure == null) "success" else "failure",
            System.nanoTime() - started,
            name,
        )
    }

    private fun finish(transaction: TransactionExecution, outcome: String) {
        val states = transactions.get() ?: return
        val state = states.remove(transaction) ?: return
        if (states.isEmpty()) transactions.remove()
        metrics.record("messenger.database.transaction", state.operation.metricValue, outcome, System.nanoTime() - state.started)
    }
}
