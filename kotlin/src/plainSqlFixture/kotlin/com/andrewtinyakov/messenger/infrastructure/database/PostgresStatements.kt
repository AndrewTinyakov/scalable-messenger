package com.andrewtinyakov.messenger.infrastructure.database

import java.sql.Statement

object PostgresStatements {
    fun execute(statement: Statement) = statement.execute("select 1")
}
