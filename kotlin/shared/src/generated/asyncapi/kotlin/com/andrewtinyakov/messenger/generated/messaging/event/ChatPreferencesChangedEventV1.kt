package com.andrewtinyakov.messenger.generated.messaging.event


data class ChatPreferencesChangedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
) {
    init {
        require(type == "chat_preferences_changed" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
        ): ChatPreferencesChangedEventV1 = ChatPreferencesChangedEventV1(
            type = RoomEventType.CHAT_PREFERENCES_CHANGED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
        )
    }
}
