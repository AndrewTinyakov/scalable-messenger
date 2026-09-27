package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxWriter
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper

@Service
class DirectChatService(
    private val repository: ChatRepository,
    private val outbox: OutboxWriter,
    private val mapper: ObjectMapper,
) {
    fun createForFirstMessage(senderId: String, recipientId: String, requestId: String): String {
        val members = listOf(senderId, recipientId)
        val key = members.sorted().joinToString(":")
        repository.lockDirectPair(key)
        repository.findByDirectKey(key)?.let { return it }
        val id = newId()
        repository.insertDirect(id, key)
        repository.insertMembers(id, members)
        val events = members.map { userId ->
            val event = ChatCreatedEventV1(
                type = "chat_created",
                version = 1,
                eventId = newId(),
                room = "user:$userId",
                chatId = id,
                requestId = requestId,
            )
            OutboxMessage(event.eventId, event.room, mapper.writeValueAsString(event))
        }
        outbox.enqueue(events)
        return id
    }
}
