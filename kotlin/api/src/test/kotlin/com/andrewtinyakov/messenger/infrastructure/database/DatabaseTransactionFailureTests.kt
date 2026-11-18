package com.andrewtinyakov.messenger.infrastructure.database

import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.transaction.TransactionSystemException
import org.springframework.transaction.support.TransactionTemplate

class DatabaseTransactionFailureTests {
    @Test
    fun `begin commit and rollback failures are distinct and leave no stale state`() {
        for (failure in listOf("begin", "commit", "rollback")) {
            SimpleMeterRegistry().let { registry ->
                val manager = FailingTransactionManager(failure).apply {
                    addListener(DatabaseTransactionListener(DatabaseMetrics(registry)))
                }
                val tx = TransactionTemplate(manager)
                assertThrows(TransactionSystemException::class.java) {
                    tx.observedExecute(DatabaseTransaction.SEND_BATCH) {
                        if (failure == "rollback") it.setRollbackOnly()
                    }
                }
                val outcome = if (failure == "begin") "begin_failed" else "failed"
                assertEquals(
                    1,
                    registry.get("messenger.database.transaction").tags("operation", "send.batch", "outcome", outcome).timer().count(),
                )
                manager.failure = null
                tx.observedExecute(DatabaseTransaction.AUTH_LOGOUT) { }
                assertEquals(
                    1,
                    registry.get("messenger.database.transaction").tags("operation", "auth.logout", "outcome", "committed").timer().count(),
                )
                assertEquals(2, registry.find("messenger.database.transaction").timers().sumOf { it.count() })
            }
        }
    }
}
