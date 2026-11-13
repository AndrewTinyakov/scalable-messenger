package com.andrewtinyakov.messenger.infrastructure.database.observability

import org.jooq.ExecuteContext
import org.jooq.ExecuteListener

class DatabaseQueryListener(
    private val metrics: DatabaseMetrics,
) : ExecuteListener {
    override fun start(ctx: ExecuteContext) {
        ctx.data(STATE, QueryState(DatabaseObservation.queryOperation.get() ?: DatabaseOperation.OTHER))
    }

    override fun executeStart(ctx: ExecuteContext) {
        state(ctx)?.statementStarted = System.nanoTime()
    }

    override fun executeEnd(ctx: ExecuteContext) {
        state(ctx)?.let { finishStatement(it, "success") }
    }

    override fun fetchStart(ctx: ExecuteContext) {
        state(ctx)?.fetchStarted = System.nanoTime()
    }

    override fun fetchEnd(ctx: ExecuteContext) {
        state(ctx)?.let { finishFetch(it, "success") }
    }

    override fun exception(ctx: ExecuteContext) {
        state(ctx)?.let {
            it.failed = true
            finishStatement(it, "failure")
            finishFetch(it, "failure")
        }
    }

    override fun end(ctx: ExecuteContext) {
        val state = ctx.data().remove(STATE) as? QueryState ?: return
        val outcome = if (state.failed || ctx.exception() != null || ctx.sqlException() != null) "failure" else "success"
        finishStatement(state, outcome)
        finishFetch(state, outcome)
        metrics.record("messenger.database.query", state.operation.metricValue, outcome, System.nanoTime() - state.started)
    }

    private fun state(ctx: ExecuteContext): QueryState? = ctx.data(STATE) as? QueryState

    private fun finishStatement(state: QueryState, outcome: String) {
        val started = state.statementStarted ?: return
        state.statementStarted = null
        metrics.record("messenger.database.statement", state.operation.metricValue, outcome, System.nanoTime() - started)
    }

    private fun finishFetch(state: QueryState, outcome: String) {
        val started = state.fetchStarted ?: return
        state.fetchStarted = null
        metrics.record("messenger.database.fetch", state.operation.metricValue, outcome, System.nanoTime() - started)
    }

    private class QueryState(
        val operation: DatabaseOperation,
    ) {
        val started = System.nanoTime()
        var statementStarted: Long? = null
        var fetchStarted: Long? = null
        var failed = false
    }

    companion object {
        private val STATE = Any()
    }
}
