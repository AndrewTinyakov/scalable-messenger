package com.andrewtinyakov.messenger.generated.messaging.event


data class ReadsChangedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
) {
    init {
        require(type == "reads_changed" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
        ): ReadsChangedEventV1 = ReadsChangedEventV1(
            type = RoomEventType.READS_CHANGED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
        )
    }
}
