package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.message.model.MessageId
import java.time.OffsetDateTime

data class ChatLastMessage(
    val id: MessageId,
    val sequence: Long,
    val senderId: UserId,
    val senderUsername: String,
    val createdAt: OffsetDateTime,
    val bodyPreview: String,
    val deleted: Boolean,
)
