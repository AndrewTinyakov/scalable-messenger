package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.infrastructure.database.monitoring.DatabaseMetrics
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener

class DatabaseQueryListener(
    private val metrics: DatabaseMetrics,
    private val entryPoints: EntryPointResolver,
    private val comment: SqlComment,
) : ExecuteListener {
    override fun start(ctx: ExecuteContext) {
        ctx.data(STATE, QueryState(entryPoints.current()))
    }

    override fun renderEnd(ctx: ExecuteContext) {
        val state = state(ctx) ?: return
        val sql = ctx.sql() ?: return
        val tagged = comment.prepend(sql, state.entryPoint)
        ctx.sql(tagged)
        if (ctx.batchMode() == ExecuteContext.BatchMode.MULTIPLE) ctx.batchSQL()[state.rendered++] = tagged
    }

    override fun end(ctx: ExecuteContext) {
        val state = ctx.data().remove(STATE) as? QueryState ?: return
        val outcome = if (ctx.exception() != null || ctx.sqlException() != null) "failure" else "success"
        metrics.record("messenger.database.query", state.entryPoint, outcome, System.nanoTime() - state.started)
    }

    private fun state(ctx: ExecuteContext): QueryState? = ctx.data(STATE) as? QueryState

    companion object {
        private val STATE = Any()
    }
}
