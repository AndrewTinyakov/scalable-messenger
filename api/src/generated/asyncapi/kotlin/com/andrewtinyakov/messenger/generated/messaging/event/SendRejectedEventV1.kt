package com.andrewtinyakov.messenger.generated.messaging.event


data class SendRejectedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String? = null,
    val recipientId: String? = null,
    val requestId: String,
    val reason: SendRejectionReason,
)