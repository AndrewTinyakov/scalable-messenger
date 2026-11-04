package com.andrewtinyakov.messenger.generated.messaging.event


data class HistoryChangedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val sequence: String,
    val mutationRevision: String,
    val visibilityRevision: String,
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
            mutationRevision: String,
            visibilityRevision: String,
        ): HistoryChangedEventV1 = HistoryChangedEventV1(
            type = RoomEventType.HISTORY_CHANGED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            sequence = sequence,
            mutationRevision = mutationRevision,
            visibilityRevision = visibilityRevision,
        )
    }
}
