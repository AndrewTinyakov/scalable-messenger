package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.outbox.OUTBOX_WAKEUP_CHANNEL
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import javax.sql.DataSource

class PostgresStatementsTests : MessengerIntegrationTest() {
    @Autowired private lateinit var dataSource: DataSource

    @Test
    fun `renders statements from typed parts`() {
        assertEquals("listen \"messenger_outbox\"", PostgresStatements.render(PostgresStatements.listen(DSL.name(OUTBOX_WAKEUP_CHANNEL))))
        assertEquals("analyze \"public\".\"messages\"", PostgresStatements.render(PostgresStatements.analyze(MESSAGES)))
    }

    @Test
    fun `explains a typed query with runtime statistics`() {
        dataSource.connection.use { connection ->
            PostgresStatements.execute(connection, PostgresStatements.analyze(MESSAGES))
            val query = db.selectFrom(MESSAGES).limit(1)
            val explain = PostgresStatements.explainAnalyze(query, PostgresExplainFormat.JSON)
            val plan = PostgresStatements.fetchText(connection, explain).single()
            assertTrue(plan.contains("\"Actual Rows\""), plan)
        }
    }
}
