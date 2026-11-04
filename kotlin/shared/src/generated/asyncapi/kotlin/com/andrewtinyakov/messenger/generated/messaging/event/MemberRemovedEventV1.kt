package com.andrewtinyakov.messenger.generated.messaging.event


data class MemberRemovedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val memberId: String,
) {
    init {
        require(type == "member_removed" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
            memberId: String,
        ): MemberRemovedEventV1 = MemberRemovedEventV1(
            type = RoomEventType.MEMBER_REMOVED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            memberId = memberId,
        )
    }
}
