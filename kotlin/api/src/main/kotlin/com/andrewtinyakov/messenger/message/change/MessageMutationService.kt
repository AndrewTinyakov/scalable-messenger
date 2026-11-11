package com.andrewtinyakov.messenger.message.change

import com.andrewtinyakov.messenger.chat.deletion.DeletionRequest
import com.andrewtinyakov.messenger.chat.deletion.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.DeletionService
import com.andrewtinyakov.messenger.chat.deletion.DeletionTarget
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.monitoring.MessageEditFailure
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
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
import com.andrewtinyakov.messenger.shared.web.parseSequence
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageMutationService(
    private val deletions: DeletionService,
    private val messages: MessageRepository,
    private val chats: ChatRepository,
    private val changes: MessageChangeRepository,
    private val outbox: OutboxRepository,
    private val tx: TransactionTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
    private val metrics: MessageMetrics,
) {
    fun edit(chatId: ChatId, userId: UserId, messageId: MessageId, body: String, expectedVersion: String): MessageResponse =
        mutate(chatId, userId, messageId, body, expectedVersion)

    fun delete(chatId: ChatId, userId: UserId, messageId: MessageId, expectedVersion: String): MessageResponse {
        requireVersion(expectedVersion)
        val previous = messages.findMessage(chatId, userId, messageId) ?: notFound()
        if (previous.messageVersion.toString() != expectedVersion) {
            throw ApiException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "Message version changed")
        }
        deletions.delete(
            chatId,
            userId,
            DeletionRequest(newId(), DeletionScope.EVERYONE, DeletionTarget.MESSAGES, listOf(messageId.value)),
            mapOf(messageId to previous.messageVersion),
        )
        return previous.copy(
            body = "",
            deletedAt = OffsetDateTime.now(clock),
            messageVersion = previous.messageVersion + 1,
            reply = null,
            replyToMessageId = null,
        ).toResponse()
    }

    private fun mutate(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId,
        body: String,
        expectedVersion: String,
    ): MessageResponse {
        val response = try {
            tx.observedExecute(DatabaseTransaction.MESSAGE_MUTATE) {
                val chat = chats.findByIdForUpdate(chatId) ?: notFound()
                val message = messages.findMessage(chatId, userId, messageId) ?: notFound()
                if (message.senderId != userId) {
                    throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, "Only the author can change a message")
                }
                if (message.forwardedFromUserId != null) {
                    throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, "Forwarded messages cannot be edited")
                }
                val version = requireVersion(expectedVersion)
                if (message.deletedAt != null || version != message.messageVersion) {
                    throw ApiException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "Message version changed")
                }
                if (body.isBlank() || body.codePointCount(0, body.length) !in 1..4000) {
                    badRequest(ApiErrorCode.INVALID_REQUEST, "body must contain 1 to 4000 characters and cannot be blank")
                }
                val revision = changes.mutate(chatId, messageId, body, OffsetDateTime.now(clock))
                val updated = checkNotNull(messages.findMessage(chatId, userId, messageId))
                val rooms = if (chat.kind == ChatKind.GROUP) {
                    listOf(RoomAddress.group(chatId))
                } else {
                    chats.findMemberIds(chatId).map(RoomAddress::user)
                }
                outbox.enqueue(
                    rooms.map { room ->
                        val event = HistoryChangedEventV1.create(
                            eventId = newId(),
                            room = room,
                            chatId = chatId.value,
                            sequence = chat.lastSequence.toString(),
                            mutationRevision = revision.toString(),
                            visibilityRevision = "0",
                        )
                        OutboxMessage(EventId(event.eventId), event.room, mapper.writeValueAsString(event))
                    },
                )
                updated.toResponse()
            }
        } catch (failure: Exception) {
            metrics.editFailed(
                when ((failure as? ApiException)?.status) {
                    HttpStatus.FORBIDDEN -> MessageEditFailure.FORBIDDEN
                    HttpStatus.CONFLICT -> MessageEditFailure.CONFLICT
                    else -> MessageEditFailure.ERROR
                },
            )
            throw failure
        }
        metrics.edited()
        return response
    }

    private fun requireVersion(value: String): Long =
        parseSequence(value)?.takeIf { it > 0 }
            ?: badRequest(ApiErrorCode.INVALID_REQUEST, "expectedVersion must be a positive decimal integer")
}
