package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MessageSavedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.RoomEventType
import com.andrewtinyakov.messenger.generated.messaging.event.SidebarActivityEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.preview
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class PublicationHydration(
    private val messageRepository: MessageRepository,
    private val userRepository: UserRepository,
    private val mapper: ObjectMapper,
    private val metrics: PublicationHydrationMetrics,
) {
    fun prepare(rows: List<OutboxMessage>): List<OutboxMessage> {
        val references = readSavedMessageReferences(rows)
        if (references.isEmpty()) return rows
        val current = findCurrentMessages(references.values)
        val usernames = findGroupSenderUsernames(rows, references, current)
        return rows.map { row ->
            val reference = references[row.id] ?: return@map row
            hydrate(row, reference, current[reference.messageId], usernames)
        }
    }

    private fun readSavedMessageReferences(rows: List<OutboxMessage>): Map<EventId, PublicationReference> = rows.mapNotNull { row ->
        val fields = runCatching { mapper.readValue(row.payload, Map::class.java) }.getOrNull() ?: return@mapNotNull null
        if (fields["type"] != RoomEventType.MESSAGE_SAVED.value) return@mapNotNull null
        row.id to PublicationReference(
            chatId = fields.string("chatId"),
            messageId = MessageId(fields.string("messageId")),
            requestId = fields.string("requestId"),
            sequence = fields.string("sequence"),
        )
    }.toMap()

    private fun findCurrentMessages(references: Collection<PublicationReference>): Map<MessageId, Message> =
        references.map { it.messageId }.distinct().chunked(Message.MAX_LOOKUP_IDS).flatMap { ids ->
            metrics.batchRequested(ids.size)
            messageRepository.findMessagesForPublication(ids)
        }.associateBy { it.id }

    // Chat-list rows show the sender's name, so group activity needs usernames. One lookup covers the batch.
    private fun findGroupSenderUsernames(
        rows: List<OutboxMessage>,
        references: Map<EventId, PublicationReference>,
        current: Map<MessageId, Message>,
    ): Map<UserId, String> {
        val senders = rows.filter { RoomAddress.isGroup(it.room) }
            .mapNotNull { row -> references[row.id]?.let { current[it.messageId]?.senderId } }
            .toSet()
        return userRepository.findSummaries(senders).associate { it.id to it.username }
    }

    private fun hydrate(
        row: OutboxMessage,
        reference: PublicationReference,
        current: Message?,
        usernames: Map<UserId, String>,
    ): OutboxMessage {
        val hint = recoveryHint(row, reference)
        val message = current?.takeIf { it.matches(reference) }
        if (message == null) {
            metrics.absent()
            return row.copy(payload = hint, replayPayload = hint)
        }
        metrics.saved()
        val activity = usernames[message.senderId]
            ?.takeIf { RoomAddress.isGroup(row.room) }
            ?.let { sidebarActivity(reference, message, it) }
        return row.copy(payload = liveMessage(row, reference, message), replayPayload = hint, activityPayload = activity)
    }

    private fun sidebarActivity(reference: PublicationReference, message: Message, senderUsername: String): String =
        mapper.writeValueAsString(
            SidebarActivityEventV1.create(
                chatId = reference.chatId,
                sequence = reference.sequence,
                messageId = message.id.value,
                senderId = message.senderId.value,
                senderUsername = senderUsername,
                createdAt = message.createdAt,
                preview = message.preview,
            ),
        )

    private fun Message.matches(reference: PublicationReference): Boolean =
        chatId.value == reference.chatId && sequence.toString() == reference.sequence && deletedAt == null

    private fun recoveryHint(row: OutboxMessage, reference: PublicationReference): String = mapper.writeValueAsString(
        HistoryChangedEventV1.create(
            eventId = row.id.value,
            room = row.room,
            chatId = reference.chatId,
            sequence = reference.sequence,
            mutationRevision = "0",
            visibilityRevision = "0",
        ),
    )

    private fun liveMessage(row: OutboxMessage, reference: PublicationReference, message: Message): String = mapper.writeValueAsString(
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
}
