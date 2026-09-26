package com.andrewtinyakov.messenger.generated.messaging.event


data class MessageSavedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val conversationId: String,
    val requestId: String,
    val messageId: String,
    val sequence: String,
    val senderId: String,
    val body: String,
    val createdAt: java.time.OffsetDateTime,
)