package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.DirectChatService
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SavedMessageReferenceV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageReply
import com.andrewtinyakov.messenger.message.model.SavedMessage
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.model.asReply
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageSendService(
    private val repository: MessageRepository,
    private val chatRepository: ChatRepository,
    private val directChatService: DirectChatService,
    private val userRepository: UserRepository,
    private val outboxRepository: OutboxRepository,
    private val tx: TransactionTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
    private val metrics: MessageSendMetrics,
) {
    fun process(command: SendMessageCommandV1): CommandResult {
        val request = command.toSendRequest()
        val window = metrics.transactionStarted()
        var synchronized = false
        try {
            return tx.observedExecute(DatabaseTransaction.SEND_SINGLE) {
                TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
                    override fun afterCompletion(status: Int) {
                        val stage = when (status) {
                            TransactionSynchronization.STATUS_COMMITTED -> SendStage.TRANSACTION_COMMITTED
                            TransactionSynchronization.STATUS_ROLLED_BACK -> SendStage.TRANSACTION_ROLLED_BACK
                            else -> SendStage.TRANSACTION_UNKNOWN
                        }
                        SendStageRecorder.record(stage, requestId = request.requestId.value)
                        window.completed()
                    }
                })
                synchronized = true
                try {
                    processInTransaction(request, window)
                } finally {
                    window.callbackFinished()
                    SendStageRecorder.record(SendStage.TRANSACTION_CALLBACK_FINISHED, requestId = request.requestId.value)
                }
            }
        } finally {
            if (!synchronized) window.completed()
        }
    }

    fun rejectExhausted(command: SendMessageCommandV1) {
        val request = command.toSendRequest()
        tx.observedExecuteWithoutResult(DatabaseTransaction.SEND_REJECT_EXHAUSTED) {
            repository.lockSend(senderId = request.senderId, requestId = request.requestId)
            if (repository.findSendResult(senderId = request.senderId, requestId = request.requestId) == null) {
                val result = rejected(request, SendRejectionReason.PROCESSING_FAILED)
                repository.insertSendResult(result)
                enqueueRejection(request, result.reason!!)
            }
        }
    }

    internal fun processBatchInTransaction(commands: List<SendMessageCommandV1>): List<CommandResult> {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Send batch requires an active transaction" }
        val requests = commands.map { it.toSendRequest() }
        requests.map { it.key }.distinct()
            .sortedWith(compareBy({ it.first.value }, { it.second.value }))
            .forEach { (sender, request) -> repository.lockSend(sender, request) }
        SendStageRecorder.requests(SendStage.REQUEST_LOCKS_ACQUIRED, requests) { it.requestId.value }
        if (requests.any { it.recipientId != null }) return commands.map(::process)
        val chatId = requireNotNull(requests.first().chatId)
        require(requests.all { it.chatId == chatId }) { "Send batch must share one chat" }
        val window = metrics.transactionStarted(requests.size)
        TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
            override fun afterCompletion(status: Int) = window.completed()
        })
        try {
            return processBatch(chatId, requests, window)
        } finally {
            window.callbackFinished()
        }
    }

    private fun processBatch(
        chatId: ChatId,
        requests: List<SendRequest>,
        window: MessageSendMetrics.TransactionWindow,
    ): List<CommandResult> {
        val existing = repository.findSendResults(
            requests.groupBy { it.senderId }.mapValues { (_, sends) -> sends.map { it.requestId } },
        ).associateBy { it.senderId to it.requestId }.toMutableMap()
        SendStageRecorder.requests(SendStage.RESULTS_LOOKED_UP, requests) { it.requestId.value }
        val chat = lockChat(chatId)
        if (chat != null) window.chatLocked()
        SendStageRecorder.requests(SendStage.CHAT_LOCKED, requests) { it.requestId.value }
        val members = if (chat == null) {
            emptySet()
        } else {
            chatRepository.existingMemberIds(chatId, requests.map { it.senderId }.distinct())
        }
        SendStageRecorder.requests(SendStage.MEMBERSHIP_CHECKED, requests) { it.requestId.value }
        val replyTargets = replyTargets(chatId, requests.filter { it.senderId in members })
        val forwardSources = forwardSources(requests.filter { it.senderId in members })
        val accepted = linkedMapOf<Pair<UserId, RequestId>, SendRequest>()
        val results = requests.map { request ->
            val previousFingerprint = existing[request.key]?.fingerprint ?: accepted[request.key]?.fingerprint
            if (previousFingerprint != null) {
                duplicateOutcome(request, previousFingerprint)
            } else {
                val reason = request.bodyRejection ?: when {
                    chat == null -> {
                        SendRejectionReason.CHAT_NOT_FOUND
                    }

                    request.senderId !in members -> {
                        SendRejectionReason.NOT_A_MEMBER
                    }

                    request.forwardSource != null && request.replyToMessageId != null -> {
                        SendRejectionReason.INVALID_FORWARD_SOURCE
                    }

                    request.replyToMessageId != null && (request.senderId to request.replyToMessageId) !in replyTargets -> {
                        SendRejectionReason.INVALID_REPLY_TARGET
                    }

                    request.forwardSource != null && (request.senderId to request.forwardSource) !in forwardSources -> {
                        SendRejectionReason.INVALID_FORWARD_SOURCE
                    }

                    else -> {
                        null
                    }
                }
                if (reason != null) {
                    existing[request.key] = reject(request, reason)
                    CommandResult.REJECTED
                } else {
                    accepted[request.key] = request
                    CommandResult.SAVED
                }
            }
        }
        if (accepted.isNotEmpty()) saveAccepted(checkNotNull(chat), accepted.values, replyTargets, forwardSources)
        return results
    }

    private fun forwardSources(requests: List<SendRequest>): Map<Pair<UserId, ForwardSource>, Message> =
        requests.mapNotNull { request -> request.forwardSource?.let { request.senderId to it } }
            .groupBy({ (sender, source) -> sender to source.chatId }, { (_, source) -> source.messageId })
            .flatMap { (key, ids) ->
                val (sender, sourceChat) = key
                ids.distinct().chunked(100).flatMap { chunk ->
                    repository.findMessagesByIds(sourceChat, sender, chunk)
                        .filter { it.deletedAt == null }
                        .map { (sender to ForwardSource(sourceChat, it.id)) to it }
                }
            }.toMap()

    private fun replyTargets(chatId: ChatId, requests: List<SendRequest>): Map<Pair<UserId, MessageId>, Message> =
        requests.filter { it.replyToMessageId != null }
            .groupBy { it.senderId }
            .flatMap { (sender, sends) ->
                repository.findMessagesByIds(chatId, sender, sends.mapNotNull { it.replyToMessageId }.distinct())
                    .filter { it.deletedAt == null }
                    .map { (sender to it.id) to it }
            }.toMap()

    private fun saveAccepted(
        chat: Chat,
        accepted: Collection<SendRequest>,
        replyTargets: Map<Pair<UserId, MessageId>, Message>,
        forwardSources: Map<Pair<UserId, ForwardSource>, Message>,
    ) {
        val firstSequence = checkNotNull(chatRepository.allocateSequencesForMembers(chat.id, accepted.map { it.senderId })) {
            "Chat membership changed during a locked send batch"
        }
        SendStageRecorder.requests(SendStage.SEQUENCES_ALLOCATED, accepted) { it.requestId.value }
        val rooms = roomsFor(chat)
        val pending = accepted.mapIndexed { index, request ->
            prepareMessage(
                request,
                chat,
                firstSequence + index,
                rooms,
                replyTargets[request.senderId to request.replyToMessageId]?.asReply(),
                request.forwardSource?.let { forwardSources[request.senderId to it] },
            )
        }
        repository.insertSavedMessages(pending.map { it.saved })
        SendStageRecorder.requests(SendStage.MESSAGES_RESULTS_WRITTEN, accepted) { it.requestId.value }
        outboxRepository.enqueue(pending.flatMap { it.events })
        SendStageRecorder.requests(SendStage.OUTBOX_WRITTEN, accepted) { it.requestId.value }
    }

    private fun processInTransaction(request: SendRequest, window: MessageSendMetrics.TransactionWindow): CommandResult {
        repository.lockSend(senderId = request.senderId, requestId = request.requestId)
        SendStageRecorder.record(SendStage.REQUEST_LOCKS_ACQUIRED, requestId = request.requestId.value)
        val existing = repository.findSendResult(senderId = request.senderId, requestId = request.requestId)
        SendStageRecorder.record(SendStage.RESULTS_LOOKED_UP, requestId = request.requestId.value)
        if (existing != null) return duplicateOutcome(request, existing.fingerprint)
        val invalid = when {
            request.recipientId != null && request.replyToMessageId != null -> {
                SendRejectionReason.INVALID_REPLY_TARGET
            }

            request.forwardSource != null && (request.recipientId != null || request.replyToMessageId != null) -> {
                SendRejectionReason.INVALID_FORWARD_SOURCE
            }

            else -> {
                request.bodyRejection
            }
        }
        if (invalid != null) return rejectedOutcome(request, invalid)
        val recipientId = request.recipientId
        val chatId = if (recipientId != null) {
            if (recipientId == request.senderId) return rejectedOutcome(request, SendRejectionReason.INVALID_RECIPIENT)
            if (!userRepository.existsById(recipientId)) return rejectedOutcome(request, SendRejectionReason.RECIPIENT_NOT_FOUND)
            directChatService.createForFirstMessage(senderId = request.senderId, recipientId = recipientId, requestId = request.requestId)
        } else {
            request.chatId!!
        }
        val chat = lockChat(chatId)
        if (chat != null) window.chatLocked()
        SendStageRecorder.record(SendStage.CHAT_LOCKED, requestId = request.requestId.value)
        if (chat == null) return rejectedOutcome(request, SendRejectionReason.CHAT_NOT_FOUND)
        val reply = request.replyToMessageId?.let { target ->
            if (!chatRepository.isMember(chatId, request.senderId)) return rejectedOutcome(request, SendRejectionReason.NOT_A_MEMBER)
            val parent = repository.findReply(chatId, request.senderId, target)
                ?: return rejectedOutcome(request, SendRejectionReason.INVALID_REPLY_TARGET)
            parent.asReply()
        }
        val forward = request.forwardSource?.let { source ->
            if (!chatRepository.isMember(chatId, request.senderId)) return rejectedOutcome(request, SendRejectionReason.NOT_A_MEMBER)
            repository.findMessage(source.chatId, request.senderId, source.messageId)?.takeIf { it.deletedAt == null }
                ?: return rejectedOutcome(request, SendRejectionReason.INVALID_FORWARD_SOURCE)
        }
        val sequence = chatRepository.allocateSequenceForMember(chatId = chatId, userId = request.senderId)
        SendStageRecorder.record(SendStage.MEMBERSHIP_CHECKED, requestId = request.requestId.value)
        if (sequence == null) return rejectedOutcome(request, SendRejectionReason.NOT_A_MEMBER)
        SendStageRecorder.record(SendStage.SEQUENCES_ALLOCATED, requestId = request.requestId.value)
        val pending = prepareMessage(request, chat, sequence, roomsFor(chat), reply, forward)
        repository.insertSavedMessage(pending.saved.message, pending.saved.result)
        SendStageRecorder.record(SendStage.MESSAGES_RESULTS_WRITTEN, requestId = request.requestId.value)
        outboxRepository.enqueue(pending.events)
        SendStageRecorder.record(SendStage.OUTBOX_WRITTEN, requestId = request.requestId.value)
        return CommandResult.SAVED
    }

    private fun lockChat(chatId: ChatId): Chat? = metrics.timeChatLock { chatRepository.findByIdForUpdate(chatId = chatId) }

    private fun roomsFor(chat: Chat): List<String> =
        if (chat.kind == ChatKind.GROUP) {
            listOf(RoomAddress.group(chat.id))
        } else {
            chatRepository.findMemberIds(chat.id).map(RoomAddress::user)
        }

    private fun duplicateOutcome(request: SendRequest, previousFingerprint: String): CommandResult {
        if (previousFingerprint == request.fingerprint) return CommandResult.DUPLICATE
        enqueueRejection(request, SendRejectionReason.REQUEST_ID_CONFLICT)
        return CommandResult.CONFLICT
    }

    private fun rejectedOutcome(request: SendRequest, reason: SendRejectionReason): CommandResult {
        reject(request, reason)
        return CommandResult.REJECTED
    }

    private fun prepareMessage(
        command: SendRequest,
        chat: Chat,
        sequence: Long,
        rooms: List<String>,
        reply: MessageReply? = null,
        forwarded: Message? = null,
    ): PendingMessage {
        val chatId = chat.id
        val now = OffsetDateTime.now(clock)
        val messageId = MessageId(newId())
        val message = Message(
            id = messageId,
            chatId = chatId,
            sequence = sequence,
            senderId = command.senderId,
            body = forwarded?.body ?: command.body,
            createdAt = now,
            reply = reply,
            forwardedFromUserId = forwarded?.let { it.forwardedFromUserId ?: it.senderId },
        )
        val saved = SavedMessage(
            message,
            SendResult(
                senderId = command.senderId,
                requestId = command.requestId,
                chatId = chatId,
                recipientId = command.recipientId,
                fingerprint = command.fingerprint,
                status = SendResultStatus.SAVED,
                messageId = messageId,
                sequence = sequence,
                reason = null,
            ),
        )
        val events = rooms.map { room ->
            SavedMessageReferenceV1.create(
                eventId = newId(),
                room = room,
                chatId = chatId.value,
                requestId = command.requestId.value,
                messageId = messageId.value,
                sequence = sequence.toString(),
            )
        }
        if (SendStageRecorder.isEnabled) {
            events.forEach { event ->
                SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = command.requestId.value, eventId = event.eventId)
            }
        }
        return PendingMessage(
            saved,
            events.map {
                OutboxMessage(id = EventId(it.eventId), room = it.room, payload = mapper.writeValueAsString(it))
            },
        )
    }

    private fun reject(command: SendRequest, reason: SendRejectionReason): SendResult {
        val result = rejected(command, reason)
        repository.insertSendResult(result)
        SendStageRecorder.record(SendStage.MESSAGES_RESULTS_WRITTEN, requestId = command.requestId.value)
        enqueueRejection(command = command, reason = reason)
        return result
    }

    private fun rejected(command: SendRequest, reason: SendRejectionReason) = SendResult(
        senderId = command.senderId,
        requestId = command.requestId,
        chatId = command.chatId,
        recipientId = command.recipientId,
        fingerprint = command.fingerprint,
        status = SendResultStatus.REJECTED,
        messageId = null,
        sequence = null,
        reason = reason,
    )

    private fun enqueueRejection(command: SendRequest, reason: SendRejectionReason) {
        enqueue(
            SendRejectedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(command.senderId),
                chatId = command.chatId?.value,
                recipientId = command.recipientId?.value,
                requestId = command.requestId.value,
                reason = reason,
            ),
        )
    }

    private fun enqueue(event: SendRejectedEventV1) {
        SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = event.requestId, eventId = event.eventId)
        outboxRepository.enqueue(eventId = EventId(event.eventId), room = event.room, payload = mapper.writeValueAsString(event))
        SendStageRecorder.record(SendStage.OUTBOX_WRITTEN, requestId = event.requestId, eventId = event.eventId)
    }

    private data class PendingMessage(
        val saved: SavedMessage,
        val events: List<OutboxMessage>,
    )
}
