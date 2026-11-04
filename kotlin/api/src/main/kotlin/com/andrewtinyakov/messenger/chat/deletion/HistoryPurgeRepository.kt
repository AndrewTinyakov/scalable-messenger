package com.andrewtinyakov.messenger.chat.deletion

import java.time.OffsetDateTime

interface HistoryPurgeRepository {
    fun purge(limit: Int): Int?

    fun cleanupPersonal(limit: Int): Int?

    fun backlog(): PurgeBacklog
}

data class PurgeBacklog(
    val sampledJobs: Int,
    val oldest: OffsetDateTime?,
)
