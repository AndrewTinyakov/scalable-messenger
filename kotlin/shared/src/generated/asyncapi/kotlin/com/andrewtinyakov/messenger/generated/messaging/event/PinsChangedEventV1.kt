package com.andrewtinyakov.messenger.generated.messaging.event


data class PinsChangedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val seq: String? = null,
    val memberSeq: String? = null,
) {
    init {
        require(type == "pins_changed" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
            seq: String? = null,
            memberSeq: String? = null,
        ): PinsChangedEventV1 = PinsChangedEventV1(
            type = RoomEventType.PINS_CHANGED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            seq = seq,
            memberSeq = memberSeq,
        )
    }
}
