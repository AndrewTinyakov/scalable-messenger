package com.andrewtinyakov.messenger.chat.preferences

import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

sealed interface MuteEnd {
    data object Forever : MuteEnd

    data class At(
        val until: OffsetDateTime,
    ) : MuteEnd
}

interface ChatPreferencesRepository {
    fun lockPins(userId: UserId)

    fun isVisibleMember(chatId: ChatId, userId: UserId): Boolean

    fun pinnedChatIds(userId: UserId): List<ChatId>

    fun replacePinnedOrder(userId: UserId, order: List<ChatId>)

    fun mute(chatId: ChatId, userId: UserId, end: MuteEnd?): Boolean

    fun markUnread(chatId: ChatId, userId: UserId, at: OffsetDateTime?): Boolean

    fun find(chatId: ChatId, userId: UserId): ChatPreferences?
}
