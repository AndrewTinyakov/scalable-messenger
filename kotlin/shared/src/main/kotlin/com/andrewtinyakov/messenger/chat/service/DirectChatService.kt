package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.RoomEventType
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper

@Service
class DirectChatService(
    private val repository: ChatRepository,
    private val mapper: ObjectMapper,
) {
    fun findBetween(userId: UserId, recipientId: UserId): ChatId? =
        repository.findByDirectKey(key = pairKey(userId, recipientId))

    fun createForFirstMessage(senderId: UserId, recipientId: UserId, requestId: RequestId): ChatId {
        val members = listOf(senderId, recipientId)
        val key = pairKey(senderId, recipientId)
        repository.lockDirectPair(key = key)
        repository.findByDirectKey(key = key)?.let { return it }
        val id = ChatId(newId())
        val events = members.map { userId ->
            val event = ChatCreatedEventV1(
                type = RoomEventType.CHAT_CREATED.value,
                version = 1,
                eventId = newId(),
                room = RoomAddress.user(userId = userId),
                chatId = id.value,
                requestId = requestId.value,
            )
            OutboxMessage(
                id = EventId(event.eventId),
                room = event.room,
                payload = mapper.writeValueAsString(event),
            )
        }
        repository.insertDirectWithMembersAndEvents(id = id, key = key, members = members, events = events)
        return id
    }

    private fun pairKey(left: UserId, right: UserId): String =
        listOf(left.value, right.value).sorted().joinToString(":")
}
