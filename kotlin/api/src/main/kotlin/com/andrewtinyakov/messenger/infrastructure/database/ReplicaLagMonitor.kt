package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.DSLContext
import org.jooq.SQLDialect
import org.jooq.exception.DataAccessException
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
import org.slf4j.LoggerFactory
import javax.sql.DataSource

class ReplicaLagMonitor(
    primary: DataSource,
    replica: DataSource,
    private val properties: ReplicaProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val primary = DSL.using(primary, SQLDialect.POSTGRES)
    private val replica = DSL.using(replica, SQLDialect.POSTGRES)

    @Volatile
    var healthy: Boolean = false
        private set

    fun check() {
        healthy = try {
            val replayed = lsn(replica, "pg_last_wal_replay_lsn")
            val written = lsn(primary, "pg_current_wal_insert_lsn")
            replayed != null && written != null && written - replayed <= properties.maxLag.toBytes()
        } catch (failure: DataAccessException) {
            logger.warn("Replica lag check failed", failure)
            false
        }
    }

    private fun lsn(db: DSLContext, function: String): Long? {
        val position = db.fetchValue(postgresFunction(function, SQLDataType.OTHER).cast(SQLDataType.CLOB)) ?: return null
        val (high, low) = position.split('/')
        return (high.toLong(16) shl 32) + low.toLong(16)
    }
}
