package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId

object RoomAddress {
    private const val USER_PREFIX = "user:"
    private const val GROUP_PREFIX = "group:"

    fun user(userId: UserId): String = "$USER_PREFIX${userId.value}"

    fun group(chatId: ChatId): String = "$GROUP_PREFIX${chatId.value}"

    fun isGroup(room: String): Boolean = room.startsWith(GROUP_PREFIX)
}
