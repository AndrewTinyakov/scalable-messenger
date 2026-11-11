package com.andrewtinyakov.messenger.chat.deletion.model

import java.time.OffsetDateTime

data class PurgeBacklog(
    val sampledJobs: Int,
    val oldest: OffsetDateTime?,
)
