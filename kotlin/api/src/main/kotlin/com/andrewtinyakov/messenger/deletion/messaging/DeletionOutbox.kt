package com.andrewtinyakov.messenger.deletion.messaging

import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.deletion.model.DeletionChat
import com.andrewtinyakov.messenger.deletion.model.DeletionRevisions
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.generated.messaging.event.ChatDeletedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class DeletionOutbox(
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    internal fun enqueueHistoryChanged(
        rooms: List<String>,
        chatId: ChatId,
        scope: DeletionScope,
        chat: DeletionChat,
        revisions: DeletionRevisions,
    ) {
        outboxRepository.enqueue(
            rooms.map { room ->
                HistoryChangedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chatId.value,
                    sequence = chat.lastSequence.toString(),
                    mutationRevision = revisions.mutation.toString(),
                    visibilityRevision = if (scope == DeletionScope.SELF) revisions.visibility.toString() else "0",
                ).toOutboxMessage(mapper)
            },
        )
    }

    fun enqueueChatDeleted(rooms: List<String>, chatId: ChatId) {
        outboxRepository.enqueue(
            rooms.map { room ->
                ChatDeletedEventV1.create(eventId = newId(), room = room, chatId = chatId.value).toOutboxMessage(mapper)
            },
        )
    }
}
