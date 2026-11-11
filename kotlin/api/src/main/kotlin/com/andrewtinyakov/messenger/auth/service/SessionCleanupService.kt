package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.OffsetDateTime

@Service
class SessionCleanupService(
    private val sessionRepository: SessionRepository,
    private val properties: AuthProperties,
    private val clock: Clock,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    fun deleteExpiredSessions() {
        try {
            val now = OffsetDateTime.now(clock)
            val batchSize = properties.sessionCleanupBatchSize
            while (sessionRepository.deleteExpired(now, batchSize) == batchSize) {
                Thread.yield()
            }
        } catch (error: RuntimeException) {
            logger.warn("Expired session cleanup will retry", error)
        }
    }
}
