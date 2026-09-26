package com.andrewtinyakov.messenger.generated.messaging.event


data class SendRejectedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val conversationId: String,
    val requestId: String,
    val reason: SendRejectionReason,
)