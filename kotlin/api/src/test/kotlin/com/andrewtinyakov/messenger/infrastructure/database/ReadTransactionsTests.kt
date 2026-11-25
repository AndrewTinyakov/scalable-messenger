package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import org.jooq.DSLContext
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

    private fun setting(name: String): String = sql.resultQuery("select current_setting('$name')").fetchOne(0, String::class.java)!!
}
