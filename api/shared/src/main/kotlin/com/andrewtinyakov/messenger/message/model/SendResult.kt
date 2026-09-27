package com.andrewtinyakov.messenger.message.model

data class SendResult(
    val senderId: String,
    val requestId: String,
    val chatId: String?,
    val recipientId: String?,
    val fingerprint: String,
    val status: SendResultStatus,
    val messageId: String?,
    val sequence: Long?,
    val reason: String?,
)
