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
        outboxRepository.enqueue(
            rooms.map { room ->
                ReadsChangedEventV1.create(eventId = newId(), room = room, chatId = chatId.value).toOutboxMessage(mapper)
            },
        )
    }

    fun enqueueReadAdvanced(chatId: ChatId, userId: UserId, memberSeq: Long, sharedRooms: List<String>) {
        val ownRoom = RoomAddress.user(userId)
        val own = ReadsChangedEventV1.create(eventId = newId(), room = ownRoom, chatId = chatId.value, memberSeq = memberSeq.toString())
        enqueueReadsChanged(chatId, sharedRooms - ownRoom)
        outboxRepository.enqueue(own.toOutboxMessage(mapper))
    }
}
