package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.Query
import org.jooq.conf.ParamType
import java.sql.Connection

internal class PostgresExplain(
    private val connection: Connection,
) {
    fun analyze(
        query: Query,
        format: PostgresExplainFormat,
    ): List<String> =
        connection.createStatement().use { statement ->
            val rendered = query.getSQL(ParamType.INLINED)
            statement.executeQuery("EXPLAIN (ANALYZE, BUFFERS, FORMAT ${format.name}) $rendered").use { result ->
                buildList {
                    while (result.next()) add(result.getString(1))
                }
            }
        }
}
