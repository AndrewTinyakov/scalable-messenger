package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.messaging.DirectChatOutbox
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.directPairKey
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Service

@Service
class DirectChatService(
    private val chatRepository: ChatRepository,
    private val directChatOutbox: DirectChatOutbox,
) {
    fun findBetween(userId: UserId, recipientId: UserId): ChatId? =
        chatRepository.findByDirectKey(key = directPairKey(userId, recipientId))

    fun createForFirstMessage(senderId: UserId, recipientId: UserId, requestId: RequestId): ChatId {
        val members = listOf(senderId, recipientId)
        val key = directPairKey(senderId, recipientId)
        chatRepository.lockDirectPair(key = key)
        chatRepository.findByDirectKey(key = key)?.let { return it }
        val id = ChatId(newId())
        val events = directChatOutbox.chatCreatedMessages(chatId = id, members = members, requestId = requestId)
        chatRepository.insertDirectWithMembersAndEvents(id = id, key = key, members = members, events = events)
        return id
    }
}
