package com.andrewtinyakov.messenger.infrastructure.outbox

import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.sql.DataSource

const val OUTBOX_WAKEUP_CHANNEL = "messenger_outbox"

@Component
class OutboxWakeup(
    private val dataSource: DataSource,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val requested = AtomicBoolean()
    private val executor = Executors.newSingleThreadExecutor(Thread.ofVirtual().name("outbox-wakeup").factory())

    fun afterCommit() {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            signal()
            return
        }
        TransactionSynchronizationManager.registerSynchronization(
            object : TransactionSynchronization {
                override fun afterCommit() = signal()
            },
        )
    }

    private fun signal() {
        if (requested.compareAndSet(false, true)) executor.execute(::notifyPublishers)
    }

    private fun notifyPublishers() {
        requested.set(false)
        try {
            dataSource.connection.use { connection ->
                connection.autoCommit = false
                connection.createStatement().use { statement ->
                    statement.execute("SET LOCAL synchronous_commit TO OFF")
                    statement.execute("NOTIFY $OUTBOX_WAKEUP_CHANNEL")
                }
                connection.commit()
            }
        } catch (error: Exception) {
            logger.warn("Outbox wakeup failed; publishers will find the events on their next poll", error)
        }
    }

    @PreDestroy
    fun close() {
        executor.shutdown()
    }
}
