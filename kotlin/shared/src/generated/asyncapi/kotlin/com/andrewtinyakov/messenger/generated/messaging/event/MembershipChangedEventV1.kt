package com.andrewtinyakov.messenger.generated.messaging.event


data class MembershipChangedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
) {
    init {
        require(type == "membership_changed" && version == 1 && room == "group:$chatId")
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
        ): MembershipChangedEventV1 = MembershipChangedEventV1(
            type = RoomEventType.MEMBERSHIP_CHANGED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
        )
    }
}
