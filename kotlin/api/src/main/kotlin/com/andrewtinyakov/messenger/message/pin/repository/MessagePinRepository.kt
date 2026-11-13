package com.andrewtinyakov.messenger.message.pin.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.pin.model.PinScope
import com.andrewtinyakov.messenger.message.pin.model.PinnedMessage

interface MessagePinRepository {
    fun lock(chatId: ChatId)

    fun count(chatId: ChatId, viewerId: UserId?): Int

    fun pin(chatId: ChatId, sequence: Long, viewerId: UserId?): Boolean

    fun unpin(chatId: ChatId, sequence: Long, viewerId: UserId): Set<PinScope>

    fun unpinAll(chatId: ChatId, viewerId: UserId): Set<PinScope>

    fun page(chatId: ChatId, viewerId: UserId, beforeSequence: Long?, limit: Int): List<PinnedMessage>

    fun visibleIds(chatId: ChatId, viewerId: UserId): List<MessageId>

    fun exists(chatId: ChatId, sequence: Long, viewerId: UserId?): Boolean
}
