package com.andrewtinyakov.messenger.infrastructure.database

import org.slf4j.LoggerFactory
import java.sql.SQLException
import javax.sql.DataSource

class ReplicaLagMonitor(
    private val primary: DataSource,
    private val replica: DataSource,
    private val properties: ReplicaProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Volatile
    var healthy: Boolean = false
        private set

    fun check() {
        healthy = try {
            val replayed = lsn(replica, "select pg_last_wal_replay_lsn()::text")
            val written = lsn(primary, "select pg_current_wal_insert_lsn()::text")
            replayed != null && written != null && written - replayed <= properties.maxLag.toBytes()
        } catch (failure: SQLException) {
            logger.warn("Replica lag check failed", failure)
            false
        }
    }

    private fun lsn(source: DataSource, query: String): Long? = source.connection.use { connection ->
        connection.createStatement().use { statement ->
            statement.executeQuery(query).use { result ->
                if (!result.next()) return null
                val (high, low) = result.getString(1)?.split('/') ?: return null
                (high.toLong(16) shl 32) + low.toLong(16)
            }
        }
    }
}
