package com.andrewtinyakov.messenger.read.messaging

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.ReadsChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class ReadOutbox(
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    fun enqueueReadsChanged(chatId: ChatId, rooms: List<String>) {
        outboxRepository.enqueue(rooms.map { room -> readsChanged(chatId, room) })
    }

    fun enqueueReadAdvanced(chatId: ChatId, userId: UserId, memberSeq: Long, sharedRooms: List<String>) {
        val ownRoom = RoomAddress.user(userId)
        outboxRepository.enqueue((sharedRooms - ownRoom).map { readsChanged(chatId, it) } + readsChanged(chatId, ownRoom, memberSeq))
    }

    private fun readsChanged(chatId: ChatId, room: String, memberSeq: Long? = null) =
        ReadsChangedEventV1.create(eventId = newId(), room = room, chatId = chatId.value, memberSeq = memberSeq?.toString())
            .toOutboxMessage(mapper)
}
