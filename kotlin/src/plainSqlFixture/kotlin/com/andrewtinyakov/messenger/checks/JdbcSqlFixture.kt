package com.andrewtinyakov.messenger.checks

import org.springframework.jdbc.core.JdbcTemplate
import java.sql.Connection
import java.sql.Statement

class JdbcSqlFixture {
    fun statementExecute(statement: Statement) = statement.execute("select 1")

    fun statementQuery(statement: Statement) = statement.executeQuery("select 1")

    fun prepare(connection: Connection) = connection.prepareStatement("select 1")

    fun template(template: JdbcTemplate) = template.update("delete from users")

    fun metadata(connection: Connection) = connection.metaData.databaseProductVersion
}
