package com.andrewtinyakov.messenger.chat.messaging

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class DirectChatOutbox(
    private val mapper: ObjectMapper,
) {
    fun chatCreatedMessages(chatId: ChatId, userSeqs: Map<UserId, Long>, requestId: RequestId): List<OutboxMessage> =
        userSeqs.map { (userId, userSeq) ->
            ChatCreatedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(userId = userId),
                chatId = chatId.value,
                requestId = requestId.value,
                userSeq = userSeq.toString(),
            ).toOutboxMessage(mapper)
        }
}
