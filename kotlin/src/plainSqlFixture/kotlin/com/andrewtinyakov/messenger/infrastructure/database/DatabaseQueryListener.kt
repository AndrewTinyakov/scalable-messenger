package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.impl.DSL

class DatabaseQueryListener : ExecuteListener {
    override fun renderEnd(ctx: ExecuteContext) {
        ctx.sql("tagged")
        ctx.batchSQL()[0] = "tagged"
        DSL.field("only the SQL tagging calls are exempt")
    }

    override fun executeEnd(ctx: ExecuteContext) {
        ctx.sql("not tagged")
        ctx.batchSQL()[0] = "not tagged"
    }
}
