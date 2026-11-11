package com.andrewtinyakov.messenger.infrastructure.redis.service

import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MessageSavedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.RoomEventType
import com.andrewtinyakov.messenger.infrastructure.outbox.model.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.monitoring.PublicationHydrationMetrics
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class PublicationHydration(
    private val messageRepository: MessageRepository,
    private val mapper: ObjectMapper,
    private val metrics: PublicationHydrationMetrics,
) {
    fun prepare(rows: List<OutboxMessage>): List<OutboxMessage> {
        val references = readSavedMessageReferences(rows)
        if (references.isEmpty()) return rows
        val current = findCurrentMessages(references.values)
        return rows.map { row ->
            val reference = references[row.id] ?: return@map row
            hydrate(row, reference, current[reference.messageId])
        }
    }

    private fun readSavedMessageReferences(rows: List<OutboxMessage>): Map<EventId, Reference> = rows.mapNotNull { row ->
        val fields = runCatching { mapper.readValue(row.payload, Map::class.java) }.getOrNull() ?: return@mapNotNull null
        if (fields["type"] != RoomEventType.MESSAGE_SAVED.value) return@mapNotNull null
        row.id to Reference(
            chatId = fields.string("chatId"),
            messageId = MessageId(fields.string("messageId")),
            requestId = fields.string("requestId"),
            sequence = fields.string("sequence"),
        )
    }.toMap()

    private fun findCurrentMessages(references: Collection<Reference>): Map<MessageId, Message> =
        references.map { it.messageId }.distinct().chunked(Message.MAX_LOOKUP_IDS).flatMap { ids ->
            metrics.batchRequested(ids.size)
            messageRepository.findMessagesForPublication(ids)
        }.associateBy { it.id }

    private fun hydrate(row: OutboxMessage, reference: Reference, current: Message?): OutboxMessage {
        val hint = recoveryHint(row, reference)
        val message = current?.takeIf { it.matches(reference) }
        val live = if (message == null) {
            metrics.absent()
            hint
        } else {
            metrics.saved()
            liveMessage(row, reference, message)
        }
        return row.copy(payload = live, replayPayload = hint)
    }

    private fun Message.matches(reference: Reference): Boolean =
        chatId.value == reference.chatId && sequence.toString() == reference.sequence && deletedAt == null

    private fun recoveryHint(row: OutboxMessage, reference: Reference): String = mapper.writeValueAsString(
        HistoryChangedEventV1.create(
            eventId = row.id.value,
            room = row.room,
            chatId = reference.chatId,
            sequence = reference.sequence,
            mutationRevision = "0",
            visibilityRevision = "0",
        ),
    )

    private fun liveMessage(row: OutboxMessage, reference: Reference, message: Message): String = mapper.writeValueAsString(
        MessageSavedEventV1.create(
            eventId = row.id.value,
            room = row.room,
            chatId = reference.chatId,
            requestId = reference.requestId,
            messageId = message.id.value,
            sequence = reference.sequence,
            senderId = message.senderId.value,
            body = message.body,
            createdAt = message.createdAt,
            messageVersion = message.messageVersion.toString(),
            replyToMessageId = message.replyToMessageId?.value,
            forwardedFromUserId = message.forwardedFromUserId?.value,
        ),
    )

    private fun Map<*, *>.string(name: String): String = requireNotNull(this[name] as? String) { "Invalid outbox $name" }

    private data class Reference(
        val chatId: String,
        val messageId: MessageId,
        val requestId: String,
        val sequence: String,
    )
}
