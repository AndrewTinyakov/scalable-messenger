package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType.VARCHAR
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.transaction.support.TransactionTemplate

class ReadTransactionsTests : MessengerIntegrationTest() {
    @Autowired private lateinit var reads: ReadTransactions

    @Autowired private lateinit var tx: TransactionTemplate

    @Autowired private lateinit var sql: DSLContext

    @Test
    fun `snapshot reads use repeatable read without changing the session default`() {
        val inside = reads.primary(snapshot = true) { setting("transaction_isolation") to setting("transaction_read_only") }
        assertEquals("repeatable read" to "on", inside)

        repeat(3) {
            assertEquals("read committed", tx.execute { setting("transaction_isolation") })
            assertEquals("read committed", setting("default_transaction_isolation"))
        }
        assertEquals("read committed", reads.primary { setting("transaction_isolation") })
    }

    @Test
    fun `snapshot settings apply to the joined transaction and reset on completion`() {
        tx.execute {
            assertEquals("repeatable read" to "on", reads.primary(snapshot = true) { transactionSettings() })
            assertEquals("repeatable read" to "on", transactionSettings())
        }
        assertEquals("read committed" to "off", tx.execute { transactionSettings() })
    }

    private fun transactionSettings(): Pair<String, String> = setting("transaction_isolation") to setting("transaction_read_only")

    private fun setting(name: String): String = sql.fetchValue(postgresFunction("current_setting", VARCHAR, DSL.`val`(name)))!!
}
