package com.andrewtinyakov.messenger.chat.deletion.scheduling

import com.andrewtinyakov.messenger.chat.deletion.HistoryPurgeService
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class HistoryPurgeScheduler(
    private val historyPurgeService: HistoryPurgeService,
) {
    @Scheduled(fixedDelayString = "\${messenger.deletion.purge-delay-ms:1000}")
    fun runPurge() = historyPurgeService.purgeDeletedHistory()
}
