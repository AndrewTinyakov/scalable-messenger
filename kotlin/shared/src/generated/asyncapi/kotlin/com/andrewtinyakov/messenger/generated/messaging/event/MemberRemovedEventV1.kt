package com.andrewtinyakov.messenger.generated.messaging.event


data class MemberRemovedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
)