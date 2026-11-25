package com.andrewtinyakov.messenger.message.messaging

import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.SavedMessageReferenceV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.SendRequest
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class MessageSendOutbox(
    private val chatRepository: ChatRepository,
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    fun rooms(chat: Chat): List<String> =
        if (chat.kind == ChatKind.GROUP) {
            listOf(RoomAddress.group(chat.id))
        } else {
            chatRepository.findMemberIds(chat.id).map(RoomAddress::user)
        }

    internal fun savedReferences(
        request: SendRequest,
        chat: Chat,
        messageId: MessageId,
        sequence: Long,
        rooms: List<String>,
    ): List<OutboxMessage> {
        val events = rooms.map { room ->
            SavedMessageReferenceV1.create(
                eventId = newId(),
                room = room,
                chatId = chat.id.value,
                requestId = request.requestId.value,
                messageId = messageId.value,
                sequence = sequence.toString(),
            )
        }
        if (SendStageRecorder.isEnabled) {
            events.forEach { event ->
                SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = request.requestId.value, eventId = event.eventId)
            }
        }
        return events.map { it.toOutboxMessage(mapper) }
    }

    fun enqueueSaved(events: List<OutboxMessage>) = outboxRepository.enqueue(events)

    internal fun enqueueRejection(request: SendRequest, reason: SendRejectionReason) {
        val event = SendRejectedEventV1.create(
            eventId = newId(),
            room = RoomAddress.user(request.senderId),
            chatId = request.chatId?.value,
            recipientId = request.recipientId?.value,
            requestId = request.requestId.value,
            reason = reason,
        )
        SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = event.requestId, eventId = event.eventId)
        outboxRepository.enqueue(event.toOutboxMessage(mapper))
        SendStageRecorder.record(SendStage.OUTBOX_WRITTEN, requestId = event.requestId, eventId = event.eventId)
    }
}
