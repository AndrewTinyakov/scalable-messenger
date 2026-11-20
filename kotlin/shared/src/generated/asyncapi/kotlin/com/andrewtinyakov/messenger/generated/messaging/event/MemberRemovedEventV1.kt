package com.andrewtinyakov.messenger.generated.messaging.event


data class MemberRemovedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val memberId: String,
    val seq: String? = null,
    val userSeq: String? = null,
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
            seq: String? = null,
            userSeq: String? = null,
        ): MemberRemovedEventV1 = MemberRemovedEventV1(
            type = RoomEventType.MEMBER_REMOVED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            memberId = memberId,
            seq = seq,
            userSeq = userSeq,
        )
    }
}
