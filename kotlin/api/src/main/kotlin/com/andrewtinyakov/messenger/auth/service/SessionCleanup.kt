package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.OffsetDateTime

private const val BATCH_SIZE = 500

@Component
class SessionCleanup(
    private val repository: SessionRepository,
    private val clock: Clock,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(
        fixedDelayString = "\${messenger.sessions.cleanup-delay-ms:60000}",
        initialDelayString = "\${messenger.sessions.cleanup-initial-delay-ms:30000}",
    )
    fun tick() {
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
