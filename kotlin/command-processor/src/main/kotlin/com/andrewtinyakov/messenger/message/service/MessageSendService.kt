package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.DirectChatService
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.MessageSavedEventV1
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
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.Duration
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
    private val metrics: MeterRegistry,
) {
    fun process(command: SendMessageCommandV1): CommandResult {
        val request = command.toRequest()
        val fingerprint = fingerprint(request)
        val invalidBody = when {
            request.recipientId != null && request.replyToMessageId != null -> SendRejectionReason.INVALID_REPLY_TARGET
            request.body.isBlank() -> SendRejectionReason.EMPTY_BODY
            request.body.codePointCount(0, request.body.length) > 4000 -> SendRejectionReason.BODY_TOO_LONG
            else -> null
        }
        val started = System.nanoTime()
        var locked: Long? = null
        var callbackFinished: Long? = null
        var observed = false

        fun completed() {
            if (observed) return
            observed = true
            val finished = System.nanoTime()
            observe("messenger.send.transaction", finished - started)
            locked?.let { observe("messenger.send.transaction.hold", finished - it) }
            callbackFinished?.let { observe("messenger.send.transaction.completion", finished - it) }
        }
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
                        completed()
                    }
                })
                synchronized = true
                try {
                    processInTransaction(request, fingerprint, invalidBody) { locked = System.nanoTime() }
                } finally {
                    callbackFinished = System.nanoTime()
                    SendStageRecorder.record(SendStage.TRANSACTION_CALLBACK_FINISHED, requestId = request.requestId.value)
                }
            }
        } finally {
            if (!synchronized) completed()
        }
    }

    fun rejectExhausted(command: SendMessageCommandV1) {
        val request = command.toRequest()
        val fingerprint = fingerprint(request)
        tx.observedExecuteWithoutResult(DatabaseTransaction.SEND_REJECT_EXHAUSTED) {
            repository.lockSend(senderId = request.senderId, requestId = request.requestId)
            if (repository.findSendResult(senderId = request.senderId, requestId = request.requestId) == null) {
                val result = rejected(command = request, fingerprint = fingerprint, reason = SendRejectionReason.PROCESSING_FAILED)
                repository.insertSendResult(result)
                enqueueRejection(command = request, reason = result.reason!!)
            }
        }
    }

    internal fun processBatchInTransaction(commands: List<SendMessageCommandV1>): List<CommandResult> {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Send batch requires an active transaction" }
        val requests = commands.map { it.toRequest() }
        requests.map { it.senderId to it.requestId }.distinct()
            .sortedWith(compareBy({ it.first.value }, { it.second.value }))
            .forEach { (sender, request) -> repository.lockSend(sender, request) }
        SendStageRecorder.requests(SendStage.REQUEST_LOCKS_ACQUIRED, requests) { it.requestId.value }
        if (requests.any { it.recipientId != null }) return commands.map(::process)
        val chatId = requireNotNull(requests.first().chatId)
        require(requests.all { it.chatId == chatId }) { "Send batch must share one chat" }
        val started = System.nanoTime()
        var locked: Long? = null
        var callbackFinished = started
        TransactionSynchronizationManager.registerSynchronization(object : TransactionSynchronization {
            override fun afterCompletion(status: Int) {
                val finished = System.nanoTime()
                repeat(requests.size) {
                    observe("messenger.send.transaction", finished - started)
                    locked?.let { observe("messenger.send.transaction.hold", finished - it) }
                    observe("messenger.send.transaction.completion", finished - callbackFinished)
                }
            }
        })
        try {
            val existing = repository.findSendResults(
                requests.groupBy { it.senderId }.mapValues { (_, sends) ->
                    sends.map { it.requestId }
                },
            )
                .associateBy { it.senderId to it.requestId }.toMutableMap()
            SendStageRecorder.requests(SendStage.RESULTS_LOOKED_UP, requests) { it.requestId.value }
            val lockStarted = System.nanoTime()
            val chat = try {
                chatRepository.findByIdForUpdate(chatId)
            } finally {
                observe("messenger.send.chat.lock.acquire", System.nanoTime() - lockStarted)
            }
            if (chat != null) locked = System.nanoTime()
            SendStageRecorder.requests(SendStage.CHAT_LOCKED, requests) { it.requestId.value }
            val members = if (chat ==
                null
            ) {
                emptySet()
            } else {
                chatRepository.existingMemberIds(chatId, requests.map { it.senderId }.distinct())
            }
            SendStageRecorder.requests(SendStage.MEMBERSHIP_CHECKED, requests) { it.requestId.value }
            val replyTargets = if (members.isEmpty()) {
                emptyMap()
            } else {
                repository.findMessagesByIds(
                    chatId,
                    members.first(),
                    requests.mapNotNull { it.replyToMessageId }.distinct(),
                ).filter { it.deletedAt == null }.associateBy { it.id }
            }
            val accepted = linkedMapOf<Pair<UserId, RequestId>, PreparedSend>()
            val results = requests.map { request ->
                val key = request.senderId to request.requestId
                val fingerprint = fingerprint(request)
                val previousFingerprint = existing[key]?.fingerprint ?: accepted[key]?.fingerprint
                if (previousFingerprint != null) {
                    if (previousFingerprint == fingerprint) {
                        CommandResult.DUPLICATE
                    } else {
                        enqueueRejection(request, SendRejectionReason.REQUEST_ID_CONFLICT)
                        CommandResult.CONFLICT
                    }
                } else {
                    val reason = when {
                        request.body.isBlank() -> {
                            SendRejectionReason.EMPTY_BODY
                        }

                        request.body.codePointCount(0, request.body.length) > 4000 -> {
                            SendRejectionReason.BODY_TOO_LONG
                        }

                        chat == null -> {
                            SendRejectionReason.CHAT_NOT_FOUND
                        }

                        request.senderId !in members -> {
                            SendRejectionReason.NOT_A_MEMBER
                        }

                        request.replyToMessageId != null && request.replyToMessageId !in replyTargets -> {
                            SendRejectionReason.INVALID_REPLY_TARGET
                        }

                        else -> {
                            null
                        }
                    }
                    if (reason != null) {
                        existing[key] = reject(request, fingerprint, reason)
                        CommandResult.REJECTED
                    } else {
                        accepted[key] = PreparedSend(request, fingerprint)
                        CommandResult.SAVED
                    }
                }
            }
            if (accepted.isNotEmpty()) {
                val firstSequence =
                    checkNotNull(chatRepository.allocateSequencesForMembers(chatId, accepted.values.map { it.request.senderId })) {
                        "Chat membership changed during a locked send batch"
                    }
                SendStageRecorder.requests(SendStage.SEQUENCES_ALLOCATED, accepted.values) { it.request.requestId.value }
                val rooms = if (chat!!.kind ==
                    ChatKind.GROUP
                ) {
                    listOf(RoomAddress.group(chatId))
                } else {
                    chatRepository.findMemberIds(chatId).map(RoomAddress::user)
                }
                val pending = accepted.values.mapIndexed { index, prepared ->
                    prepareMessage(
                        prepared.request,
                        prepared.fingerprint,
                        chat,
                        firstSequence + index,
                        rooms,
                        replyTargets[prepared.request.replyToMessageId]?.asReply(),
                    )
                }
                repository.insertSavedMessages(pending.map { it.saved })
                SendStageRecorder.requests(SendStage.MESSAGES_RESULTS_WRITTEN, accepted.values) { it.request.requestId.value }
                outboxRepository.enqueue(pending.flatMap { it.events })
                SendStageRecorder.requests(SendStage.OUTBOX_WRITTEN, accepted.values) { it.request.requestId.value }
            }
            return results
        } finally {
            callbackFinished = System.nanoTime()
        }
    }

    private fun processInTransaction(
        command: SendRequest,
        fingerprint: String,
        invalidBody: SendRejectionReason?,
        onLocked: () -> Unit,
    ): CommandResult {
        repository.lockSend(senderId = command.senderId, requestId = command.requestId)
        SendStageRecorder.record(SendStage.REQUEST_LOCKS_ACQUIRED, requestId = command.requestId.value)
        val existing = repository.findSendResult(senderId = command.senderId, requestId = command.requestId)
        SendStageRecorder.record(SendStage.RESULTS_LOOKED_UP, requestId = command.requestId.value)
        if (existing != null) {
            if (existing.fingerprint != fingerprint) enqueueRejection(command = command, reason = SendRejectionReason.REQUEST_ID_CONFLICT)
            return if (existing.fingerprint != fingerprint) CommandResult.CONFLICT else CommandResult.DUPLICATE
        }
        if (invalidBody != null) {
            reject(command = command, fingerprint = fingerprint, reason = invalidBody)
            return CommandResult.REJECTED
        }
        val recipientId = command.recipientId
        val chatId = if (recipientId != null) {
            if (recipientId == command.senderId) {
                reject(command = command, fingerprint = fingerprint, reason = SendRejectionReason.INVALID_RECIPIENT)
                return CommandResult.REJECTED
            }
            if (!userRepository.existsById(recipientId)) {
                reject(command = command, fingerprint = fingerprint, reason = SendRejectionReason.RECIPIENT_NOT_FOUND)
                return CommandResult.REJECTED
            }
            directChatService.createForFirstMessage(senderId = command.senderId, recipientId = recipientId, requestId = command.requestId)
        } else {
            command.chatId!!
        }
        val lockStarted = System.nanoTime()
        val chat = try {
            chatRepository.findByIdForUpdate(chatId = chatId)
        } finally {
            observe("messenger.send.chat.lock.acquire", System.nanoTime() - lockStarted)
        }
        if (chat != null) onLocked()
        SendStageRecorder.record(SendStage.CHAT_LOCKED, requestId = command.requestId.value)
        if (chat == null) {
            reject(command = command, fingerprint = fingerprint, reason = SendRejectionReason.CHAT_NOT_FOUND)
            return CommandResult.REJECTED
        }
        val reply = command.replyToMessageId?.let { target ->
            if (!chatRepository.isMember(chatId, command.senderId)) {
                reject(command, fingerprint, SendRejectionReason.NOT_A_MEMBER)
                return CommandResult.REJECTED
            }
            val parent = repository.findReply(chatId, command.senderId, target)
            if (parent == null) {
                reject(command, fingerprint, SendRejectionReason.INVALID_REPLY_TARGET)
                return CommandResult.REJECTED
            }
            parent.asReply()
        }
        val sequence = chatRepository.allocateSequenceForMember(chatId = chatId, userId = command.senderId)
        SendStageRecorder.record(SendStage.MEMBERSHIP_CHECKED, requestId = command.requestId.value)
        if (sequence == null) {
            reject(command = command, fingerprint = fingerprint, reason = SendRejectionReason.NOT_A_MEMBER)
            return CommandResult.REJECTED
        }
        SendStageRecorder.record(SendStage.SEQUENCES_ALLOCATED, requestId = command.requestId.value)
        val rooms = if (chat.kind == ChatKind.GROUP) {
            listOf(RoomAddress.group(chatId))
        } else {
            chatRepository.findMemberIds(chatId).map(RoomAddress::user)
        }
        val pending = prepareMessage(command, fingerprint, chat, sequence, rooms, reply)
        repository.insertSavedMessage(pending.saved.message, pending.saved.result)
        SendStageRecorder.record(SendStage.MESSAGES_RESULTS_WRITTEN, requestId = command.requestId.value)
        outboxRepository.enqueue(pending.events)
        SendStageRecorder.record(SendStage.OUTBOX_WRITTEN, requestId = command.requestId.value)
        return CommandResult.SAVED
    }

    private fun prepareMessage(
        command: SendRequest,
        fingerprint: String,
        chat: Chat,
        sequence: Long,
        rooms: List<String>,
        reply: MessageReply? = null,
    ): PendingMessage {
        val chatId = chat.id
        val now = OffsetDateTime.now(clock)
        val messageId = MessageId(newId())
        val message = Message(
            id = messageId,
            chatId = chatId,
            sequence = sequence,
            senderId = command.senderId,
            body = command.body,
            createdAt = now,
            reply = reply,
        )
        val saved = SavedMessage(
            message,
            SendResult(
                senderId = command.senderId,
                requestId = command.requestId,
                chatId = chatId,
                recipientId = command.recipientId,
                fingerprint = fingerprint,
                status = SendResultStatus.SAVED,
                messageId = messageId,
                sequence = sequence,
                reason = null,
            ),
        )
        val events = rooms.map { room ->
            MessageSavedEventV1.create(
                eventId = newId(),
                room = room,
                chatId = chatId.value,
                requestId = command.requestId.value,
                messageId = messageId.value,
                sequence = sequence.toString(),
                senderId = command.senderId.value,
                body = command.body,
                createdAt = now,
                messageVersion = message.messageVersion.toString(),
                replyToMessageId = reply?.messageId?.value,
                replySenderId = reply?.senderId?.value,
                replyBody = reply?.body,
                replyDeleted = reply?.deleted,
                replyVersion = reply?.version?.toString(),
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

    private fun reject(command: SendRequest, fingerprint: String, reason: SendRejectionReason): SendResult {
        val result = rejected(command = command, fingerprint = fingerprint, reason = reason)
        repository.insertSendResult(result)
        SendStageRecorder.record(SendStage.MESSAGES_RESULTS_WRITTEN, requestId = command.requestId.value)
        enqueueRejection(command = command, reason = reason)
        return result
    }

    private fun rejected(command: SendRequest, fingerprint: String, reason: SendRejectionReason) = SendResult(
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

    private fun fingerprint(command: SendRequest): String {
        val target = command.chatId?.value ?: "direct:${command.recipientId?.value}"
        val reply = command.replyToMessageId
        return if (reply == null) {
            sha256("$target\u0000${command.senderId.value}\u0000${command.body}")
        } else {
            sha256("reply-v1\u0000$target\u0000${command.senderId.value}\u0000${reply.value}\u0000${command.body}")
        }
    }

    private fun SendMessageCommandV1.toRequest(): SendRequest {
        require(version == 1) { "Unsupported command version" }
        require((chatId == null) != (recipientId == null)) { "Exactly one chat target is required" }
        return SendRequest(
            chatId = chatId?.let(::ChatId),
            recipientId = recipientId?.let(::UserId),
            requestId = RequestId(requestId),
            senderId = UserId(senderId),
            body = body,
            replyToMessageId = replyToMessageId?.let(::MessageId),
        )
    }

    private fun observe(name: String, nanos: Long) {
        Timer.builder(
            name,
        ).publishPercentileHistogram().minimumExpectedValue(
            Duration.ofMillis(1),
        ).maximumExpectedValue(Duration.ofMinutes(2)).register(metrics).record(Duration.ofNanos(nanos))
    }

    private data class SendRequest(
        val chatId: ChatId?,
        val recipientId: UserId?,
        val requestId: RequestId,
        val senderId: UserId,
        val body: String,
        val replyToMessageId: MessageId?,
    )

    private data class PreparedSend(
        val request: SendRequest,
        val fingerprint: String,
    )

    private data class PendingMessage(
        val saved: SavedMessage,
        val events: List<OutboxMessage>,
    )
}
