package com.andrewtinyakov.messenger.generated.messaging.event


data class ChatDeletedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
) {
    init {
        require(type == "chat_deleted" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
        ): ChatDeletedEventV1 = ChatDeletedEventV1(
            type = RoomEventType.CHAT_DELETED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
        )
    }
}
