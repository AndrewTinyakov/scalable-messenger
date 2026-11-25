package com.andrewtinyakov.messenger.message.messaging

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.messaging.ChatEventAudience
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.PinsChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class MessageOutbox(
    private val chatEventAudience: ChatEventAudience,
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    fun enqueueHistoryChanged(chat: Chat, seq: Long) {
        outboxRepository.enqueue(
            chatEventAudience.rooms(chat.id, chat.kind).map { room ->
                HistoryChangedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chat.id.value,
                    sequence = seq.toString(),
                    seq = seq.toString(),
                ).toOutboxMessage(mapper)
            },
        )
    }

    fun enqueuePinsChanged(chat: Chat, change: Long, personalViewer: UserId?) {
        outboxRepository.enqueue(
            chatEventAudience.rooms(chat.id, chat.kind, personalViewer).map { room ->
                PinsChangedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chat.id.value,
                    seq = change.toString().takeIf { personalViewer == null },
                    memberSeq = change.toString().takeIf { personalViewer != null },
                ).toOutboxMessage(mapper)
            },
        )
    }
}
