package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId

object RoomAddress {
    fun user(userId: UserId): String = "user:${userId.value}"

    fun group(chatId: ChatId): String = "group:${chatId.value}"
}
