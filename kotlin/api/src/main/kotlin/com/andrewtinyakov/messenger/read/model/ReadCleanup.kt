package com.andrewtinyakov.messenger.read.model

import java.time.OffsetDateTime

data class ReadCleanup(
    val ranges: Int,
    val notifications: Int,
    val backlog: Int,
    val oldestExpiredAt: OffsetDateTime?,
) {
    companion object {
        const val BACKLOG_SAMPLE_CAP = 10000
    }
}
