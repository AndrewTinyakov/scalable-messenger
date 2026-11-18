package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.message.model.MessageId

internal data class PublicationReference(
    val chatId: String,
    val messageId: MessageId,
    val requestId: String,
    val sequence: String,
)
