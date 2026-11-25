package com.andrewtinyakov.messenger.generated.messaging.event


data class SidebarActivityEventV1(
    val type: String,
    val version: Int,
    val chatId: String,
    val sequence: String,
    val messageId: String? = null,
    val senderId: String? = null,
    val senderUsername: String? = null,
    val createdAt: java.time.OffsetDateTime? = null,
    val preview: String? = null,
) {
    init {
        require(type == "sidebar_activity" && version == 1)
    }

    companion object {
        fun create(
            chatId: String,
            sequence: String,
            messageId: String? = null,
            senderId: String? = null,
            senderUsername: String? = null,
            createdAt: java.time.OffsetDateTime? = null,
            preview: String? = null,
        ): SidebarActivityEventV1 = SidebarActivityEventV1(
            type = RoomEventType.SIDEBAR_ACTIVITY.value,
            version = 1,
            chatId = chatId,
            sequence = sequence,
            messageId = messageId,
            senderId = senderId,
            senderUsername = senderUsername,
            createdAt = createdAt,
            preview = preview,
        )
    }
}
