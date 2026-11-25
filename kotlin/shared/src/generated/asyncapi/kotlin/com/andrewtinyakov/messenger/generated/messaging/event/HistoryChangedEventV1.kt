package com.andrewtinyakov.messenger.generated.messaging.event


data class HistoryChangedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val sequence: String,
    val seq: String? = null,
    val memberSeq: String? = null,
) {
    init {
        require(type == "history_changed" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
            sequence: String,
            seq: String? = null,
            memberSeq: String? = null,
        ): HistoryChangedEventV1 = HistoryChangedEventV1(
            type = RoomEventType.HISTORY_CHANGED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            sequence = sequence,
            seq = seq,
            memberSeq = memberSeq,
        )
    }
}
