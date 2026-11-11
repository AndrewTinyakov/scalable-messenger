package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId

object RoomAddress {
    fun user(userId: UserId): String = "user:${userId.value}"

    fun group(chatId: ChatId): String = "group:${chatId.value}"
}
