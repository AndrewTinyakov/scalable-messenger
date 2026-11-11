package com.andrewtinyakov.messenger.read.model

import java.time.OffsetDateTime

data class ReadProgress(
    val throughSequence: Long,
    val readAt: OffsetDateTime?,
)
