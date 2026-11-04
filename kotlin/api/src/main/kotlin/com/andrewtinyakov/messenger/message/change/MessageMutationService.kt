package com.andrewtinyakov.messenger.message.change

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.MessageChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageMutationService(
    private val messages: MessageRepository,
    private val chats: ChatRepository,
    private val changes: MessageChangeRepository,
    private val outbox: OutboxRepository,
    private val tx: TransactionTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
    private val metrics: MeterRegistry,
) {
    fun edit(chatId: ChatId, userId: UserId, messageId: MessageId, body: String, expectedVersion: String): MessageResponse =
        mutate(chatId, userId, messageId, body, expectedVersion)

    fun delete(chatId: ChatId, userId: UserId, messageId: MessageId, expectedVersion: String): MessageResponse =
        mutate(chatId, userId, messageId, null, expectedVersion)

    private fun mutate(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId,
        body: String?,
        expectedVersion: String,
    ): MessageResponse {
        val kind = if (body == null) "delete" else "edit"
        var outcome = "failed"
        try {
            val response = tx.observedExecute(DatabaseTransaction.MESSAGE_MUTATE) {
                val chat = chats.findByIdForUpdate(chatId) ?: notFound()
                val message = messages.findMessage(chatId, userId, messageId) ?: notFound()
                if (message.senderId != userId) {
                    outcome = "forbidden"
                    throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, "Only the author can change a message")
                }
                val version = expectedVersion.takeIf { Regex("[1-9][0-9]{0,18}").matches(it) }?.toLongOrNull()
                    ?: badRequest(ApiErrorCode.INVALID_REQUEST, "expectedVersion must be a positive decimal integer")
                if (body == null && message.deletedAt != null) return@observedExecute message.toResponse()
                if (message.deletedAt != null || version != message.messageVersion) {
                    outcome = "conflict"
                    throw ApiException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "Message version changed")
                }
                if (body != null && (body.isBlank() || body.codePointCount(0, body.length) !in 1..4000)) {
                    badRequest(ApiErrorCode.INVALID_REQUEST, "body must contain 1 to 4000 characters and cannot be blank")
                }
                val revision = changes.mutate(chatId, messageId, body ?: "", body == null, OffsetDateTime.now(clock))
                val updated = checkNotNull(messages.findMessage(chatId, userId, messageId))
                val rooms = if (chat.kind == ChatKind.GROUP) {
                    listOf(RoomAddress.group(chatId))
                } else {
                    chats.findMemberIds(chatId).map(RoomAddress::user)
                }
                outbox.enqueue(
                    rooms.map { room ->
                        val event = MessageChangedEventV1.create(
                            eventId = newId(),
                            room = room,
                            chatId = chatId.value,
                            messageId = messageId.value,
                            sequence = updated.sequence.toString(),
                            senderId = updated.senderId.value,
                            body = updated.body,
                            createdAt = updated.createdAt,
                            messageVersion = updated.messageVersion.toString(),
                            mutationRevision = revision.toString(),
                            editedAt = updated.editedAt,
                            deletedAt = updated.deletedAt,
                            replyToMessageId = updated.reply?.messageId?.value,
                            replySenderId = updated.reply?.senderId?.value,
                            replyBody = updated.reply?.body,
                            replyDeleted = updated.reply?.deleted,
                            replyVersion = updated.reply?.version?.toString(),
                        )
                        OutboxMessage(EventId(event.eventId), event.room, mapper.writeValueAsString(event))
                    },
                )
                updated.toResponse()
            }
            outcome = "success"
            return response
        } finally {
            metrics.counter("messenger.message.mutations", "kind", kind, "outcome", outcome).increment()
        }
    }
}
