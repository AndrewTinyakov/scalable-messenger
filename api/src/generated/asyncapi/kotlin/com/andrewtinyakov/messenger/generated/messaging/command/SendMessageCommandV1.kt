package com.andrewtinyakov.messenger.generated.messaging.command


data class SendMessageCommandV1(
    val version: Int,
    val conversationId: String,
    val requestId: String,
    val senderId: String,
    val body: String,
    val sentAt: java.time.OffsetDateTime,
)