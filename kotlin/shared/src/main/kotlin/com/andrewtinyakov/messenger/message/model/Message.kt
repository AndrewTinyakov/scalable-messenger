package com.andrewtinyakov.messenger.message.model

import java.time.OffsetDateTime

data class Message(
    val id: String,
    val chatId: String,
    val sequence: Long,
    val senderId: String,
    val body: String,
    val createdAt: OffsetDateTime,
)
