package com.andrewtinyakov.messenger.read.model

import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

data class ReadProgress(
    val throughSequence: Long,
    val readAt: OffsetDateTime?,
)

data class ReadAdvance(
    val progress: ReadProgress,
    val advanced: Boolean,
    val rangesWritten: Int = 0,
)

data class ReadSummary(
    val throughSequence: Long,
    val maxOtherReadSequence: Long,
)

data class MessageReadTarget(
    val sequence: Long,
    val createdAt: OffsetDateTime,
    val deleted: Boolean,
)

data class MessageReader(
    val userId: UserId,
    val username: String,
    val readAt: OffsetDateTime,
)

data class ReadCleanup(
    val ranges: Int,
    val notifications: Int,
    val backlog: Int,
    val oldestExpiredAt: OffsetDateTime?,
)
