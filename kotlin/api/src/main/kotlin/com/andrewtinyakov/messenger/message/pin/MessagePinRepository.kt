package com.andrewtinyakov.messenger.message.pin

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId

enum class PinScope {
    SELF,
    EVERYONE,
}

data class PinnedMessage(
    val messageId: MessageId,
    val sequence: Long,
    val scope: PinScope,
)

interface MessagePinRepository {
    fun lock(chatId: ChatId)

    fun count(chatId: ChatId, viewerId: UserId?): Int

    fun pin(chatId: ChatId, sequence: Long, viewerId: UserId?): Boolean

    fun unpin(chatId: ChatId, sequence: Long, viewerId: UserId): Set<PinScope>

    fun unpinAll(chatId: ChatId, viewerId: UserId): Set<PinScope>

    fun page(chatId: ChatId, viewerId: UserId, beforeSequence: Long?, limit: Int): List<PinnedMessage>

    fun visibleCount(chatId: ChatId, viewerId: UserId): Int
}
