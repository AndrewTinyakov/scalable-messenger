package com.andrewtinyakov.messenger.auth.scheduling

import com.andrewtinyakov.messenger.auth.service.SessionCleanupService
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class SessionCleanupScheduler(
    private val sessionCleanupService: SessionCleanupService,
) {
    @Scheduled(
        fixedDelayString = "\${messenger.sessions.cleanup-delay-ms:60000}",
        initialDelayString = "\${messenger.sessions.cleanup-initial-delay-ms:30000}",
    )
    fun runCleanup() = sessionCleanupService.deleteExpiredSessions()
}
