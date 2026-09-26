package com.andrewtinyakov.messenger.messaging

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.shared.newId
import com.andrewtinyakov.messenger.shared.requireId
import com.andrewtinyakov.messenger.shared.sha256
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Service
class SendCommandService(
    private val repository: SendRepository,
    private val tx: TransactionTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
) {
    fun process(command: SendMessageCommandV1) {
        require(command.version == 1) { "Unsupported command version" }
        requireId(command.conversationId)
        requireId(command.requestId)
        requireId(command.senderId)
        tx.executeWithoutResult { processInTransaction(command) }
    }

    fun rejectExhausted(command: SendMessageCommandV1) {
        require(command.version == 1) { "Unsupported command version" }
        requireId(command.conversationId)
        requireId(command.requestId)
        requireId(command.senderId)
        tx.executeWithoutResult {
            repository.lockConversation(command.conversationId)
            if (repository.findRequest(command.conversationId, command.senderId, command.requestId) == null) {
                val fingerprint = sha256("${command.conversationId}\u0000${command.senderId}\u0000${command.body}")
                val inserted = repository.insertRejected(
                    command.conversationId,
                    command.senderId,
                    command.requestId,
                    fingerprint,
                    "PROCESSING_FAILED",
                )
                if (inserted) {
                    enqueue(
                        RoomEventV1(
                            type = "send_rejected",
                            eventId = newId(),
                            room = "user:${command.senderId}",
                            conversationId = command.conversationId,
                            requestId = command.requestId,
                            reason = "PROCESSING_FAILED",
                        ),
                    )
                }
            }
        }
    }

    private fun processInTransaction(command: SendMessageCommandV1) {
        val now = OffsetDateTime.now(clock)
        val fingerprint = sha256("${command.conversationId}\u0000${command.senderId}\u0000${command.body}")
        // A row lock serializes allocation and deduplication for this conversation.
        val kind = repository.lockConversation(command.conversationId)
        val existing = repository.findRequest(command.conversationId, command.senderId, command.requestId)
        if (existing != null) {
            if (existing.fingerprint != fingerprint) {
                enqueue(
                    RoomEventV1(
                        type = "send_rejected",
                        eventId = newId(),
                        room = "user:${command.senderId}",
                        conversationId = command.conversationId,
                        requestId = command.requestId,
                        reason = "REQUEST_ID_CONFLICT",
                    ),
                )
            }
            return
        }
        val member = kind != null && repository.isMember(command.conversationId, command.senderId)
        val reason = when {
            kind == null -> "CONVERSATION_NOT_FOUND"
            !member -> "NOT_A_MEMBER"
            command.body.isBlank() -> "EMPTY_BODY"
            command.body.codePointCount(0, command.body.length) > 4000 -> "BODY_TOO_LONG"
            else -> null
        }
        if (reason != null) {
            val inserted = repository.insertRejected(
                command.conversationId,
                command.senderId,
                command.requestId,
                fingerprint,
                reason,
            )
            if (!inserted) return
            enqueue(
                RoomEventV1(
                    type = "send_rejected",
                    eventId = newId(),
                    room = "user:${command.senderId}",
                    conversationId = command.conversationId,
                    requestId = command.requestId,
                    reason = reason,
                ),
            )
            return
        }
        val sequence = repository.allocateSequence(command.conversationId)
        val messageId = newId()
        repository.insertMessage(
            messageId,
            command.conversationId,
            sequence,
            command.senderId,
            command.body,
            now,
        )
        repository.insertSaved(
            command.conversationId,
            command.senderId,
            command.requestId,
            fingerprint,
            messageId,
            sequence,
        )
        val rooms = if (kind == "group") {
            listOf("group:${command.conversationId}")
        } else {
            repository.memberIds(command.conversationId).map { "user:$it" }
        }
        rooms.forEach { room ->
            enqueue(
                RoomEventV1(
                    type = "message_saved",
                    eventId = newId(),
                    room = room,
                    conversationId = command.conversationId,
                    requestId = command.requestId,
                    messageId = messageId,
                    sequence = sequence.toString(),
                    senderId = command.senderId,
                    body = command.body,
                    createdAt = now.toString(),
                ),
            )
        }
    }

    private fun enqueue(event: RoomEventV1) {
        repository.enqueue(event.eventId, event.room, mapper.writeValueAsString(event))
    }
}
