package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.chat.model.MuteEnd
import java.time.OffsetDateTime

interface ChatPreferencesRepository {
    fun lockPins(userId: UserId)

    fun isVisibleMember(chatId: ChatId, userId: UserId): Boolean

    fun pinnedChatIds(userId: UserId): List<ChatId>

    fun replacePinnedOrder(userId: UserId, order: List<ChatId>)

    fun mute(chatId: ChatId, userId: UserId, end: MuteEnd?): Boolean

    fun markUnread(chatId: ChatId, userId: UserId, at: OffsetDateTime?): Boolean

    fun find(chatId: ChatId, userId: UserId): ChatPreferences?
}
