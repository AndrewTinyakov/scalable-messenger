package com.andrewtinyakov.messenger.read.scheduling

import com.andrewtinyakov.messenger.read.service.ReadService
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class ReadNotificationScheduler(
    private val readService: ReadService,
) {
    @Scheduled(
        fixedDelayString = $$"${messenger.read.notification-delay-ms:100}",
        initialDelayString = $$"${messenger.read.notification-initial-delay-ms:100}",
    )
    fun runPendingNotifications() = readService.publishPendingNotifications()
}
