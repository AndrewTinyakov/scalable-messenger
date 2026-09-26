package com.andrewtinyakov.messenger.messaging

import com.fasterxml.jackson.annotation.JsonInclude

@JsonInclude(JsonInclude.Include.NON_NULL)
data class RoomEventV1(
    val type: String,
    val version: Int = 1,
    val eventId: String,
    val room: String,
    val conversationId: String,
    val requestId: String,
    val messageId: String? = null,
    val sequence: String? = null,
    val senderId: String? = null,
    val body: String? = null,
    val createdAt: String? = null,
    val reason: String? = null,
)
