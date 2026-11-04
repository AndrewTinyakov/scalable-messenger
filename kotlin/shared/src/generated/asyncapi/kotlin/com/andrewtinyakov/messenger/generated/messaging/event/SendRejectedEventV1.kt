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
) {
    init {
        require(type == "send_rejected" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String? = null,
            recipientId: String? = null,
            requestId: String,
            reason: SendRejectionReason,
        ): SendRejectedEventV1 = SendRejectedEventV1(
            type = RoomEventType.SEND_REJECTED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            recipientId = recipientId,
            requestId = requestId,
            reason = reason,
        )
    }
}
