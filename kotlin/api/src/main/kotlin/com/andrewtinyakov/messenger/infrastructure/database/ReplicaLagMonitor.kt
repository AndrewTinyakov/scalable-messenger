package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.DSLContext
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled

class ReplicaLagMonitor(
    private val db: DSLContext,
    private val properties: ReplicaProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Volatile
    var healthy: Boolean = false
        private set

    @Scheduled(fixedDelayString = "\${messenger.database.replica.check-interval:1s}")
    fun check() {
        healthy = try {
            val lag = db.resultQuery(
                "select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), replay_lsn) from pg_stat_replication where application_name = ? and replay_lsn is not null",
                properties.name,
            ).fetchOne(0, Long::class.java)
            lag != null && lag <= properties.maxLag.toBytes()
        } catch (failure: RuntimeException) {
            logger.warn("Replica lag check failed", failure)
            false
        }
    }
}
