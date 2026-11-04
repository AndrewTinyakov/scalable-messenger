package com.andrewtinyakov.messenger.generated.messaging.event


data class SavedMessageReferenceV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val requestId: String,
    val messageId: String,
    val sequence: String,
) {
    init {
        require(type == "message_saved" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
            requestId: String,
            messageId: String,
            sequence: String,
        ): SavedMessageReferenceV1 = SavedMessageReferenceV1(
            type = RoomEventType.MESSAGE_SAVED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            requestId = requestId,
            messageId = messageId,
            sequence = sequence,
        )
    }
}
