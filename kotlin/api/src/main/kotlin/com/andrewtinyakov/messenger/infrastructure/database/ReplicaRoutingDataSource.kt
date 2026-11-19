package com.andrewtinyakov.messenger.infrastructure.database

import org.springframework.jdbc.datasource.lookup.AbstractRoutingDataSource
import javax.sql.DataSource

class ReplicaRoutingDataSource(
    primary: DataSource,
    replica: DataSource,
) : AbstractRoutingDataSource() {
    private val onReplica = ThreadLocal<Boolean>()

    init {
        setDefaultTargetDataSource(primary)
        setTargetDataSources(mapOf<Any, Any>(REPLICA to replica))
        setLenientFallback(false)
        afterPropertiesSet()
    }

    override fun determineCurrentLookupKey(): Any? = if (onReplica.get() == true) REPLICA else null

    fun <T> onReplica(block: () -> T): T {
        check(onReplica.get() == null) { "Replica routing cannot be nested" }
        onReplica.set(true)
        return try {
            block()
        } finally {
            onReplica.remove()
        }
    }

    private companion object {
        const val REPLICA = "replica"
    }
}
