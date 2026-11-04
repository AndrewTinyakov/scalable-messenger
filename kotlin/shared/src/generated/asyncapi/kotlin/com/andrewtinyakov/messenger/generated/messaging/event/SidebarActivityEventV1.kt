package com.andrewtinyakov.messenger.generated.messaging.event


data class SidebarActivityEventV1(
    val type: String,
    val version: Int,
    val chatId: String,
    val sequence: String,
) {
    init {
        require(type == "sidebar_activity" && version == 1)
    }

    companion object {
        fun create(
            chatId: String,
            sequence: String,
        ): SidebarActivityEventV1 = SidebarActivityEventV1(
            type = RoomEventType.SIDEBAR_ACTIVITY.value,
            version = 1,
            chatId = chatId,
            sequence = sequence,
        )
    }
}
