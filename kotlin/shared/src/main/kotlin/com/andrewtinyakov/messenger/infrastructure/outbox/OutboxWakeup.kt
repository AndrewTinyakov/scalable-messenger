package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.postgresFunction
import jakarta.annotation.PreDestroy
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
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
                DSL.using(connection, SQLDialect.POSTGRES).select(
                    postgresFunction("set_config", SQLDataType.CLOB, DSL.inline("synchronous_commit"), DSL.inline("off"), DSL.inline(true)),
                    postgresFunction("pg_notify", SQLDataType.OTHER, DSL.inline(OUTBOX_WAKEUP_CHANNEL), DSL.inline("")),
                ).fetch()
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
