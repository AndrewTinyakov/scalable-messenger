package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MessageSavedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.RoomEventType
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.id.MessageId
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class PublicationHydration(
    private val messages: MessageRepository,
    private val mapper: ObjectMapper,
    private val metrics: MeterRegistry,
) {
    fun prepare(rows: List<OutboxMessage>): List<OutboxMessage> {
        val references = rows.mapNotNull { row ->
            val fields = runCatching { mapper.readValue(row.payload, Map::class.java) }.getOrNull() ?: return@mapNotNull null
            if (fields["type"] != RoomEventType.MESSAGE_SAVED.value) return@mapNotNull null
            row.id to Reference(
                chatId = fields.string("chatId"),
                messageId = MessageId(fields.string("messageId")),
                requestId = fields.string("requestId"),
                sequence = fields.string("sequence"),
            )
        }.toMap()
        if (references.isEmpty()) return rows
        val current = references.values.map { it.messageId }.distinct().chunked(100).flatMap { ids ->
            metrics.summary("messenger.outbox.hydration.batch").record(ids.size.toDouble())
            messages.findMessagesForPublication(ids)
        }.associateBy { it.id }
        return rows.map { row ->
            val reference = references[row.id] ?: return@map row
            val hint = mapper.writeValueAsString(
                HistoryChangedEventV1.create(
                    eventId = row.id.value,
                    room = row.room,
                    chatId = reference.chatId,
                    sequence = reference.sequence,
                    mutationRevision = "0",
                    visibilityRevision = "0",
                ),
            )
            val message = current[reference.messageId]?.takeIf {
                it.chatId.value == reference.chatId && it.sequence.toString() == reference.sequence && it.deletedAt == null
            }
            val live = if (message == null) {
                metrics.counter("messenger.outbox.hydration", "result", "absent").increment()
                hint
            } else {
                metrics.counter("messenger.outbox.hydration", "result", "saved").increment()
                mapper.writeValueAsString(
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
                    ),
                )
            }
            row.copy(payload = live, replayPayload = hint)
        }
    }

    private fun Map<*, *>.string(name: String): String = requireNotNull(this[name] as? String) { "Invalid outbox $name" }

    private data class Reference(
        val chatId: String,
        val messageId: MessageId,
        val requestId: String,
        val sequence: String,
    )
}
