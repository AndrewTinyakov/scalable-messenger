package com.andrewtinyakov.messenger.read.model

import com.andrewtinyakov.messenger.auth.model.UserId
import java.time.OffsetDateTime

data class MessageReader(
    val userId: UserId,
    val username: String,
    val readAt: OffsetDateTime,
)
