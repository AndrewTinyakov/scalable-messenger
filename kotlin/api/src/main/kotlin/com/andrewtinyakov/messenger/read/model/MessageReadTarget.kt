package com.andrewtinyakov.messenger.read.model

import java.time.OffsetDateTime

data class MessageReadTarget(
    val sequence: Long,
    val createdAt: OffsetDateTime,
    val deleted: Boolean,
) {
    companion object {
        const val DETAILS_RETENTION_DAYS = 7L
    }
}
