package com.andrewtinyakov.messenger.deletion.repository

import com.andrewtinyakov.messenger.deletion.model.PurgeBacklog

interface HistoryPurgeRepository {
    fun purge(limit: Int): Int?

    fun cleanupPersonal(limit: Int): Int?

    fun backlog(): PurgeBacklog
}
