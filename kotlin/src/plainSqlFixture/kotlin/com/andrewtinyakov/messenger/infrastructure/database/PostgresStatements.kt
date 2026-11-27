package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.Context
import org.jooq.Name
import org.jooq.QueryPart
import org.jooq.impl.CustomQueryPart
import java.sql.Statement

object PostgresStatements {
    fun listen(channel: Name): QueryPart = object : CustomQueryPart() {
        override fun accept(ctx: Context<*>) {
            ctx.sql("listen ").visit(channel)
        }
    }

    fun execute(statement: Statement) = statement.execute("select 1")
}
