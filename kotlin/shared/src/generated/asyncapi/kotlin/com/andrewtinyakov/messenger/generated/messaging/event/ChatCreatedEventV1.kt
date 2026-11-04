package com.andrewtinyakov.messenger.generated.messaging.event


data class ChatCreatedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val requestId: String? = null,
) {
    init {
        require(type == "chat_created" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
            requestId: String? = null,
        ): ChatCreatedEventV1 = ChatCreatedEventV1(
            type = RoomEventType.CHAT_CREATED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            requestId = requestId,
        )
    }
}
