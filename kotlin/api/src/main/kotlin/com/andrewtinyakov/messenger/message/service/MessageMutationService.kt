package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.service.DeletionService
import com.andrewtinyakov.messenger.message.messaging.MessageOutbox
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.monitoring.MessageEditFailure
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import com.andrewtinyakov.messenger.message.repository.MessageChangeRepository
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageMutationService(
    private val deletionService: DeletionService,
    private val messageRepository: MessageRepository,
    private val chatRepository: ChatRepository,
    private val messageOutbox: MessageOutbox,
    private val messageChangeRepository: MessageChangeRepository,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: MessageMetrics,
) {
    fun edit(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId,
        body: String,
        expectedVersion: Long,
    ): MessageResponse {
        val response = try {
            tx.execute {
                val chat = chatRepository.findByIdForUpdate(chatId) ?: notFound()
                requireEditableMessage(
                    chatId = chatId,
                    userId = userId,
                    messageId = messageId,
                    expectedVersion = expectedVersion,
                )
                requireValidBody(body)
                val seq = chatRepository.allocateEventSequence(chatId, userId) ?: notFound()
                messageChangeRepository.edit(chatId, messageId, body, OffsetDateTime.now(clock), seq)
                val updated = checkNotNull(messageRepository.findMessage(chatId, userId, messageId))
                messageOutbox.enqueueHistoryChanged(chat, seq)
                updated.toResponse()
            }
        } catch (failure: Exception) {
            metrics.editFailed(editFailure(failure))
            throw failure
        }
        metrics.edited()
        return response
    }

    fun delete(chatId: ChatId, userId: UserId, messageId: MessageId, expectedVersion: Long): MessageResponse {
        val previous = messageRepository.findMessage(chatId, userId, messageId) ?: notFound()
        if (previous.messageVersion != expectedVersion) versionChanged()
        deletionService.deleteMessages(
            chatId = chatId,
            userId = userId,
            requestId = RequestId(newId()),
            scope = DeletionScope.EVERYONE,
            messageIds = listOf(messageId),
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

    private fun requireEditableMessage(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId,
        expectedVersion: Long,
    ) {
        val message = messageRepository.findMessage(chatId, userId, messageId) ?: notFound()
        if (message.senderId != userId) forbidden("Only the author can change a message")
        if (message.forwardedFromUserId != null) forbidden("Forwarded messages cannot be edited")
        if (message.deletedAt != null || expectedVersion != message.messageVersion) versionChanged()
    }

    private fun requireValidBody(body: String) {
        if (body.isBlank() || body.codePointCount(0, body.length) !in 1..Message.MAX_BODY_LENGTH) {
            invalidInput("body", "body must contain 1 to ${Message.MAX_BODY_LENGTH} characters and cannot be blank")
        }
    }

    private fun editFailure(failure: Exception): MessageEditFailure = when ((failure as? ApiException)?.status) {
        HttpStatus.FORBIDDEN -> MessageEditFailure.FORBIDDEN
        HttpStatus.CONFLICT -> MessageEditFailure.CONFLICT
        else -> MessageEditFailure.ERROR
    }

    private fun versionChanged(): Nothing = conflict(ApiErrorCode.VERSION_CHANGED, "Message version changed")
}
