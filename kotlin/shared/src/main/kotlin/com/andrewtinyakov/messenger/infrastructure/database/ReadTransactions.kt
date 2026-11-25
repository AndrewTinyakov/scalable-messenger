package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.DSLContext
import org.springframework.beans.factory.ObjectProvider
import org.springframework.dao.DataAccessResourceFailureException
import org.springframework.dao.TransientDataAccessException
import org.springframework.stereotype.Component
import org.springframework.transaction.CannotCreateTransactionException
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate

@Component
class ReadTransactions(
    transactionManager: PlatformTransactionManager,
    private val db: DSLContext,
    replicaRoute: ObjectProvider<ReplicaRoute>,
    private val metrics: DatabaseMetrics,
) {
    private val readOnly = TransactionTemplate(transactionManager).apply { isReadOnly = true }
    private val replicaRoute = replicaRoute.getIfAvailable()

    fun <T> primary(snapshot: Boolean = false, block: () -> T): T = read(snapshot, block)

    fun <T : Any> replica(snapshot: Boolean = false, block: () -> T?): T? {
        val route = replicaRoute?.takeIf { it.available() } ?: return null.also { metrics.replicaRead(ReplicaReadOutcome.UNAVAILABLE) }
        check(!TransactionSynchronizationManager.isActualTransactionActive()) { "A replica read must start outside a transaction" }
        return try {
            route.on { read(snapshot, block) }.also {
                metrics.replicaRead(
                    if (it ==
                        null
                    ) {
                        ReplicaReadOutcome.REJECTED
                    } else {
                        ReplicaReadOutcome.SERVED
                    },
                )
            }
        } catch (failure: DataAccessResourceFailureException) {
            metrics.replicaRead(ReplicaReadOutcome.FAILED)
            null
        } catch (failure: CannotCreateTransactionException) {
            metrics.replicaRead(ReplicaReadOutcome.FAILED)
            null
        } catch (failure: TransientDataAccessException) {
            metrics.replicaRead(ReplicaReadOutcome.FAILED)
            null
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> read(snapshot: Boolean, block: () -> T): T = readOnly.execute {
        if (snapshot) db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        block()
    } as T
}
