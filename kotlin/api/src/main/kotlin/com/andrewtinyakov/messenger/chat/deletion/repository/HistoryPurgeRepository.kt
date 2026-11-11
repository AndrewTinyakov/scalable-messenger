package com.andrewtinyakov.messenger.chat.deletion.repository

import com.andrewtinyakov.messenger.chat.deletion.model.PurgeBacklog

interface HistoryPurgeRepository {
    fun purge(limit: Int): Int?

    fun cleanupPersonal(limit: Int): Int?

    fun backlog(): PurgeBacklog
}
