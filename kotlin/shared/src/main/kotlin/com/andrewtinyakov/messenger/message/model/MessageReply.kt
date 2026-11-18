package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.auth.model.UserId

data class MessageReply(
    val messageId: MessageId,
    val senderId: UserId,
    val body: String,
    val deleted: Boolean,
    val version: Long,
)
