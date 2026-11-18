package com.andrewtinyakov.messenger.read.scheduling

import com.andrewtinyakov.messenger.read.service.ReadCleanupService
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class ReadCleanupScheduler(
    private val readCleanupService: ReadCleanupService,
) {
    @Scheduled(
        fixedDelayString = $$"${messenger.read.cleanup-delay-ms:1000}",
        initialDelayString = $$"${messenger.read.cleanup-initial-delay-ms:10000}",
    )
    fun runCleanup() = readCleanupService.cleanup()
}
