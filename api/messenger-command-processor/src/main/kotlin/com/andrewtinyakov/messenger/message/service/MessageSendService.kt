package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.DirectChatService
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.MessageSavedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxWriter
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.user.repository.UserRepository
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageSendService(
    private val repository: MessageRepository,
    private val chatRepository: ChatRepository,
    private val chats: DirectChatService,
    private val users: UserRepository,
    private val outbox: OutboxWriter,
    private val tx: TransactionTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
) {
    fun process(command: SendMessageCommandV1): String {
        validate(command)
        return tx.execute { processInTransaction(command) }
    }

    fun rejectExhausted(command: SendMessageCommandV1) {
        validate(command)
        tx.executeWithoutResult {
            repository.lockSend(command.senderId, command.requestId)
            if (repository.findSendResult(command.senderId, command.requestId) == null) {
                val result = rejected(command, fingerprint(command), "PROCESSING_FAILED")
                repository.insertSendResult(result)
                enqueueRejection(command, result.reason!!)
            }
        }
    }

    private fun processInTransaction(command: SendMessageCommandV1): String {
        repository.lockSend(command.senderId, command.requestId)
        val fingerprint = fingerprint(command)
        val existing = repository.findSendResult(command.senderId, command.requestId)
        if (existing != null) {
            if (existing.fingerprint != fingerprint) enqueueRejection(command, "REQUEST_ID_CONFLICT")
            return if (existing.fingerprint != fingerprint) "conflict" else "duplicate"
        }
        val invalidBody = when {
            command.body.isBlank() -> "EMPTY_BODY"
            command.body.codePointCount(0, command.body.length) > 4000 -> "BODY_TOO_LONG"
            else -> null
        }
        if (invalidBody != null) {
            reject(command, fingerprint, invalidBody)
            return "rejected"
        }
        val recipientId = command.recipientId
        val chatId = if (recipientId != null) {
            if (recipientId == command.senderId) {
                reject(command, fingerprint, "INVALID_RECIPIENT")
                return "rejected"
            }
            if (!users.existsById(recipientId)) {
                reject(command, fingerprint, "RECIPIENT_NOT_FOUND")
                return "rejected"
            }
            chats.createForFirstMessage(command.senderId, recipientId, command.requestId)
        } else {
            command.chatId!!
        }
        val kind = chatRepository.findKindForUpdate(chatId)
        if (kind == null) {
            reject(command, fingerprint, "CHAT_NOT_FOUND")
            return "rejected"
        }
        if (!chatRepository.isMember(chatId, command.senderId)) {
            reject(command, fingerprint, "NOT_A_MEMBER")
            return "rejected"
        }
        val now = OffsetDateTime.now(clock)
        val sequence = chatRepository.allocateSequence(chatId)
        val messageId = newId()
        repository.insertMessage(messageId, chatId, sequence, command.senderId, command.body, now)
        repository.insertSendResult(
            SendResult(
                senderId = command.senderId,
                requestId = command.requestId,
                chatId = chatId,
                recipientId = recipientId,
                fingerprint = fingerprint,
                status = SendResultStatus.SAVED,
                messageId = messageId,
                sequence = sequence,
                reason = null,
            ),
        )
        val rooms = if (kind == ChatKind.GROUP) {
            listOf("group:$chatId")
        } else {
            chatRepository.findMemberIds(chatId).map { "user:$it" }
        }
        val events = rooms.map { room ->
            MessageSavedEventV1(
                type = "message_saved",
                version = 1,
                eventId = newId(),
                room = room,
                chatId = chatId,
                requestId = command.requestId,
                messageId = messageId,
                sequence = sequence.toString(),
                senderId = command.senderId,
                body = command.body,
                createdAt = now,
            )
        }
        outbox.enqueue(events.map { OutboxMessage(it.eventId, it.room, mapper.writeValueAsString(it)) })
        return "saved"
    }

    private fun reject(command: SendMessageCommandV1, fingerprint: String, reason: String) {
        repository.insertSendResult(rejected(command, fingerprint, reason))
        enqueueRejection(command, reason)
    }

    private fun rejected(command: SendMessageCommandV1, fingerprint: String, reason: String) = SendResult(
        senderId = command.senderId,
        requestId = command.requestId,
        chatId = command.chatId,
        recipientId = command.recipientId,
        fingerprint = fingerprint,
        status = SendResultStatus.REJECTED,
        messageId = null,
        sequence = null,
        reason = reason,
    )

    private fun enqueueRejection(command: SendMessageCommandV1, reason: String) {
        enqueue(
            SendRejectedEventV1(
                type = "send_rejected",
                version = 1,
                eventId = newId(),
                room = "user:${command.senderId}",
                chatId = command.chatId,
                recipientId = command.recipientId,
                requestId = command.requestId,
                reason = SendRejectionReason.valueOf(reason),
            ),
        )
    }

    private fun enqueue(event: MessageSavedEventV1) {
        outbox.enqueue(event.eventId, event.room, mapper.writeValueAsString(event))
    }

    private fun enqueue(event: SendRejectedEventV1) {
        outbox.enqueue(event.eventId, event.room, mapper.writeValueAsString(event))
    }

    private fun fingerprint(command: SendMessageCommandV1): String =
        sha256("${command.chatId ?: "direct:${command.recipientId}"}\u0000${command.senderId}\u0000${command.body}")

    private fun validate(command: SendMessageCommandV1) {
        val chatId = command.chatId
        val recipientId = command.recipientId
        require(command.version == 1) { "Unsupported command version" }
        require((chatId == null) != (recipientId == null)) { "Exactly one chat target is required" }
        require(chatId == null || validId(chatId)) { "Invalid chat ID" }
        require(recipientId == null || validId(recipientId)) { "Invalid recipient ID" }
        require(validId(command.requestId) && validId(command.senderId)) { "Invalid request identity" }
    }

    private fun validId(value: String): Boolean = Regex("[0-7][0-9A-HJKMNP-TV-Z]{25}").matches(value)
}
