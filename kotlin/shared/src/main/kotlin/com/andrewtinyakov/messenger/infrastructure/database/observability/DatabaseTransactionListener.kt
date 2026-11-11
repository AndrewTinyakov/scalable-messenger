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
        if (beginFailure != null) finish(transaction, "begin_failed") else state.phase = Phase.Active(System.nanoTime())
    }

    override fun beforeCommit(transaction: TransactionExecution) = beforeCompletion(transaction, CompletionPhase.COMMIT)

    override fun beforeRollback(transaction: TransactionExecution) = beforeCompletion(transaction, CompletionPhase.ROLLBACK)

    override fun afterCommit(transaction: TransactionExecution, commitFailure: Throwable?) {
        afterCompletion(transaction, commitFailure, if (commitFailure == null) "committed" else "failed")
    }

    override fun afterRollback(transaction: TransactionExecution, rollbackFailure: Throwable?) {
        afterCompletion(transaction, rollbackFailure, if (rollbackFailure == null) "rolled_back" else "failed")
    }

    private fun beforeCompletion(transaction: TransactionExecution, completion: CompletionPhase) {
        val state = transactions.get()?.get(transaction) ?: return
        val active = state.phase as? Phase.Active
        active?.let { phase(state, "active", it.started, null) }
        state.phase = Phase.Completing(completion, System.nanoTime())
    }

    private fun afterCompletion(transaction: TransactionExecution, failure: Throwable?, outcome: String) {
        val state = transactions.get()?.get(transaction) ?: return
        when (val current = state.phase) {
            Phase.Beginning -> Unit
            is Phase.Active -> phase(state, "active", current.started, null)
            is Phase.Completing -> phase(state, current.completion.metricValue, current.started, failure)
        }
        finish(transaction, outcome)
    }

    private fun phase(state: State, name: String, started: Long, failure: Throwable?) {
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

    private enum class CompletionPhase(
        val metricValue: String,
    ) {
        COMMIT("commit"),
        ROLLBACK("rollback"),
    }

    private sealed interface Phase {
        data object Beginning : Phase

        data class Active(
            val started: Long,
        ) : Phase

        data class Completing(
            val completion: CompletionPhase,
            val started: Long,
        ) : Phase
    }

    private class State(
        val operation: DatabaseTransaction,
    ) {
        val started = System.nanoTime()
        var phase: Phase = Phase.Beginning
    }
}
