package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.OffsetDateTime

private const val BATCH_SIZE = 500

@Service
class SessionCleanupService(
    private val repository: SessionRepository,
    private val clock: Clock,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    fun deleteExpiredSessions() {
        try {
            val now = OffsetDateTime.now(clock)
            while (repository.deleteExpired(now, BATCH_SIZE) == BATCH_SIZE) {
                Thread.yield()
            }
        } catch (error: RuntimeException) {
            log.warn("Expired session cleanup will retry", error)
        }
    }
}
