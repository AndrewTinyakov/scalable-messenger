package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.Context
import org.jooq.Name
import org.jooq.Query
import org.jooq.QueryPart
import org.jooq.SQLDialect
import org.jooq.Table
import org.jooq.impl.CustomQueryPart
import org.jooq.impl.DSL
import java.sql.Connection

object PostgresStatements {
    private val renderer = DSL.using(SQLDialect.POSTGRES)

    fun listen(channel: Name): QueryPart = object : CustomQueryPart() {
        override fun accept(ctx: Context<*>) {
            ctx.sql("listen ").visit(channel)
        }
    }

    fun analyze(table: Table<*>): QueryPart = object : CustomQueryPart() {
        override fun accept(ctx: Context<*>) {
            ctx.sql("analyze ").visit(table)
        }
    }

    fun dropDatabase(database: Name): QueryPart = object : CustomQueryPart() {
        override fun accept(ctx: Context<*>) {
            ctx.sql("drop database if exists ").visit(database).sql(" with (force)")
        }
    }

    fun explainAnalyze(query: Query, format: PostgresExplainFormat): QueryPart = object : CustomQueryPart() {
        override fun accept(ctx: Context<*>) {
            ctx.sql("explain (analyze, buffers, format ").sql(format.name.lowercase()).sql(") ").visit(query)
        }
    }

    fun render(statement: QueryPart): String = renderer.renderInlined(statement)

    fun execute(connection: Connection, statement: QueryPart) {
        connection.createStatement().use { it.execute(render(statement)) }
    }

    fun fetchText(connection: Connection, statement: QueryPart): List<String> =
        connection.createStatement().use { jdbc ->
            jdbc.executeQuery(render(statement)).use { result ->
                buildList { while (result.next()) add(result.getString(1)) }
            }
        }
}
