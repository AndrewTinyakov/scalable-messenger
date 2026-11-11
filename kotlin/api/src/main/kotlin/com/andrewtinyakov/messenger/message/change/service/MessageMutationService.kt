package com.andrewtinyakov.messenger.message.change.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionCommand
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.chat.deletion.service.DeletionService
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.ChatEventAudience
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.model.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxRepository
import com.andrewtinyakov.messenger.message.change.repository.MessageChangeRepository
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.monitoring.MessageEditFailure
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.notFound
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
    private val audience: ChatEventAudience,
    private val changes: MessageChangeRepository,
    private val outbox: OutboxRepository,
    private val tx: TransactionTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
    private val metrics: MessageMetrics,
) {
    fun edit(chatId: ChatId, userId: UserId, messageId: MessageId, body: String, expectedVersion: Long): MessageResponse =
        mutate(chatId, userId, messageId, body, expectedVersion)

    fun delete(chatId: ChatId, userId: UserId, messageId: MessageId, expectedVersion: Long): MessageResponse {
        val previous = messages.findMessage(chatId, userId, messageId) ?: notFound()
        if (previous.messageVersion != expectedVersion) versionChanged()
        deletions.delete(
            chatId = chatId,
            actorId = userId,
            command = DeletionCommand(
                requestId = RequestId(newId()),
                scope = DeletionScope.EVERYONE,
                target = DeletionTarget.MESSAGES,
                messageIds = listOf(messageId),
            ),
            expectedVersions = mapOf(messageId to previous.messageVersion),
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
        expectedVersion: Long,
    ): MessageResponse {
        val response = try {
            tx.observedExecute(DatabaseTransaction.MESSAGE_MUTATE) {
                val chat = chats.findByIdForUpdate(chatId) ?: notFound()
                requireEditableMessage(
                    chatId = chatId,
                    userId = userId,
                    messageId = messageId,
                    expectedVersion = expectedVersion,
                )
                requireValidBody(body)
                val revision = changes.mutate(chatId, messageId, body, OffsetDateTime.now(clock))
                val updated = checkNotNull(messages.findMessage(chatId, userId, messageId))
                enqueueHistoryChanged(chat, revision)
                updated.toResponse()
            }
        } catch (failure: Exception) {
            metrics.editFailed(editFailure(failure))
            throw failure
        }
        metrics.edited()
        return response
    }

    private fun requireEditableMessage(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId,
        expectedVersion: Long,
    ) {
        val message = messages.findMessage(chatId, userId, messageId) ?: notFound()
        if (message.senderId != userId) forbidden("Only the author can change a message")
        if (message.forwardedFromUserId != null) forbidden("Forwarded messages cannot be edited")
        if (message.deletedAt != null || expectedVersion != message.messageVersion) versionChanged()
    }

    private fun requireValidBody(body: String) {
        if (body.isBlank() || body.codePointCount(0, body.length) !in 1..4000) {
            badRequest(ApiErrorCode.INVALID_REQUEST, "body must contain 1 to 4000 characters and cannot be blank")
        }
    }

    private fun enqueueHistoryChanged(chat: Chat, revision: Long) {
        outbox.enqueue(
            audience.rooms(chat.id, chat.kind).map { room ->
                HistoryChangedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chat.id.value,
                    sequence = chat.lastSequence.toString(),
                    mutationRevision = revision.toString(),
                    visibilityRevision = "0",
                ).toOutboxMessage(mapper)
            },
        )
    }

    private fun editFailure(failure: Exception): MessageEditFailure = when ((failure as? ApiException)?.status) {
        HttpStatus.FORBIDDEN -> MessageEditFailure.FORBIDDEN
        HttpStatus.CONFLICT -> MessageEditFailure.CONFLICT
        else -> MessageEditFailure.ERROR
    }

    private fun versionChanged(): Nothing = conflict(ApiErrorCode.INVALID_REQUEST, "Message version changed")
}
