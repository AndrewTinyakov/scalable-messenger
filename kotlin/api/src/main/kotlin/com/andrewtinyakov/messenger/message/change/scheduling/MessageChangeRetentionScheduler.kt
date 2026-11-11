package com.andrewtinyakov.messenger.message.change.scheduling

import com.andrewtinyakov.messenger.message.change.service.MessageChangeRetentionService
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class MessageChangeRetentionScheduler(
    private val messageChangeRetentionService: MessageChangeRetentionService,
) {
    @Scheduled(fixedDelayString = "\${messenger.message-changes.cleanup-delay-ms:60000}")
    fun runRetention() = messageChangeRetentionService.pruneExpiredChanges()
}
