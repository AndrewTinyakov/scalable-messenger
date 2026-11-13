package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
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
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.model.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.MessageReply
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.model.SavedMessage
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.model.SendTarget
import com.andrewtinyakov.messenger.message.model.asReply
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics.TransactionWindow
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageSendService(
    private val messageRepository: MessageRepository,
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
        return inSingleSendTransaction(request) { window ->
            lockRequests(listOf(request))
            send(listOf(request), window).single()
        }
    }

    fun rejectExhausted(command: SendMessageCommandV1) {
        val request = command.toSendRequest()
        tx.observedExecuteWithoutResult(DatabaseTransaction.SEND_REJECT_EXHAUSTED) {
            messageRepository.lockSend(senderId = request.senderId, requestId = request.requestId)
            if (messageRepository.findSendResult(senderId = request.senderId, requestId = request.requestId) == null) {
                val result = rejected(request, SendRejectionReason.PROCESSING_FAILED)
                messageRepository.insertSendResult(result)
                enqueueRejection(request, result.reason!!)
            }
        }
    }

    internal fun processBatchInTransaction(commands: List<SendMessageCommandV1>): List<CommandResult> {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Send batch requires an active transaction" }
        val requests = commands.map { it.toSendRequest() }
        lockRequests(requests)
        val window = metrics.transactionStarted(requests.size)
        afterSendTransactionCompletes { window.completed() }
        try {
            return send(requests, window)
        } finally {
            window.callbackFinished()
        }
    }

    private fun inSingleSendTransaction(request: SendRequest, action: (TransactionWindow) -> CommandResult): CommandResult {
        val window = metrics.transactionStarted()
        var synchronized = false
        try {
            return tx.observedExecute(DatabaseTransaction.SEND_SINGLE) {
                afterSendTransactionCompletes { completion ->
                    SendStageRecorder.record(completion.stage, requestId = request.requestId.value)
                    window.completed()
                }
                synchronized = true
                try {
                    action(window)
                } finally {
                    window.callbackFinished()
                    SendStageRecorder.record(SendStage.TRANSACTION_CALLBACK_FINISHED, requestId = request.requestId.value)
                }
            }
        } finally {
            if (!synchronized) window.completed()
        }
    }

    private fun send(requests: List<SendRequest>, window: TransactionWindow): List<CommandResult> {
        val target = sharedTarget(requests)
        val priorResults = findPriorResults(requests)
        val firstAttempts = requests.filterNot { it.key in priorResults }.distinctBy { it.key }
        val requestRejections = firstAttempts.associate { it.key to requestRejection(it) }
        val sendable = firstAttempts.filter { requestRejections[it.key] == null }
        val chat = lockChat(resolveChat(target, sendable), requests, window)
        val context = inspectChat(chat, requests, sendable)
        val decisions = decide(requests, priorResults, requestRejections, context)
        return recordDecisions(decisions, context)
    }

    private fun lockRequests(requests: List<SendRequest>) {
        requests.map { it.key }.distinct()
            .sortedWith(compareBy({ it.first.value }, { it.second.value }))
            .forEach { (sender, request) -> messageRepository.lockSend(sender, request) }
        SendStageRecorder.requests(SendStage.REQUEST_LOCKS_ACQUIRED, requests) { it.requestId.value }
    }

    private fun sharedTarget(requests: List<SendRequest>): SendTarget {
        val target = SendTarget.from(requests.first())
        require(requests.all { SendTarget.from(it) == target }) { "Send batch must share one target" }
        return target
    }

    private fun findPriorResults(requests: List<SendRequest>): Map<Pair<UserId, RequestId>, SendResult> {
        val results = messageRepository.findSendResults(
            requests.groupBy { it.senderId }.mapValues { (_, sends) -> sends.map { it.requestId } },
        ).associateBy { it.senderId to it.requestId }
        SendStageRecorder.requests(SendStage.RESULTS_LOOKED_UP, requests) { it.requestId.value }
        return results
    }

    private fun requestRejection(request: SendRequest): SendRejectionReason? =
        request.draftReferenceRejection ?: request.bodyRejection ?: recipientRejection(request)

    private fun recipientRejection(request: SendRequest): SendRejectionReason? {
        val recipientId = request.recipientId ?: return null
        return when {
            recipientId == request.senderId -> SendRejectionReason.INVALID_RECIPIENT
            !userRepository.existsById(recipientId) -> SendRejectionReason.RECIPIENT_NOT_FOUND
            else -> null
        }
    }

    private fun resolveChat(target: SendTarget, sendable: List<SendRequest>): ChatId? = when (target) {
        is SendTarget.ExistingChat -> {
            target.id
        }

        is SendTarget.DirectPair -> {
            sendable.firstOrNull()?.let { first ->
                directChatService.createForFirstMessage(
                    senderId = first.senderId,
                    recipientId = checkNotNull(first.recipientId),
                    requestId = first.requestId,
                )
            }
        }
    }

    private fun lockChat(chatId: ChatId?, requests: List<SendRequest>, window: TransactionWindow): Chat? {
        val chat = chatId?.let { metrics.timeChatLock { chatRepository.findByIdForUpdate(chatId = it) } }
        if (chat != null) window.chatLocked()
        SendStageRecorder.requests(SendStage.CHAT_LOCKED, requests) { it.requestId.value }
        return chat
    }

    private fun inspectChat(chat: Chat?, requests: List<SendRequest>, sendable: List<SendRequest>): ChatContext {
        val members = chat?.let { chatRepository.existingMemberIds(it.id, requests.map { request -> request.senderId }.distinct()) }
            .orEmpty()
        SendStageRecorder.requests(SendStage.MEMBERSHIP_CHECKED, requests) { it.requestId.value }
        val memberRequests = sendable.filter { it.senderId in members }
        return ChatContext(
            chat = chat,
            members = members,
            replyTargets = chat?.let { findReplyTargets(it.id, memberRequests) }.orEmpty(),
            forwardSources = findForwardSources(memberRequests),
        )
    }

    private fun findReplyTargets(chatId: ChatId, requests: List<SendRequest>): Map<Pair<UserId, MessageId>, Message> =
        requests.filter { it.replyToMessageId != null }
            .groupBy { it.senderId }
            .flatMap { (sender, sends) ->
                messageRepository.findMessagesByIds(chatId, sender, sends.mapNotNull { it.replyToMessageId }.distinct())
                    .filter { it.deletedAt == null }
                    .map { (sender to it.id) to it }
            }.toMap()

    private fun findForwardSources(requests: List<SendRequest>): Map<Pair<UserId, ForwardSource>, Message> =
        requests.mapNotNull { request -> request.forwardSource?.let { request.senderId to it } }
            .groupBy({ (sender, source) -> sender to source.chatId }, { (_, source) -> source.messageId })
            .flatMap { (key, ids) ->
                val (sender, sourceChat) = key
                ids.distinct().chunked(Message.MAX_LOOKUP_IDS).flatMap { chunk ->
                    messageRepository.findMessagesByIds(sourceChat, sender, chunk)
                        .filter { it.deletedAt == null }
                        .map { (sender to ForwardSource(sourceChat, it.id)) to it }
                }
            }.toMap()

    private fun decide(
        requests: List<SendRequest>,
        priorResults: Map<Pair<UserId, RequestId>, SendResult>,
        requestRejections: Map<Pair<UserId, RequestId>, SendRejectionReason?>,
        context: ChatContext,
    ): List<SendDecision> {
        val fingerprintsInBatch = mutableMapOf<Pair<UserId, RequestId>, String>()
        return requests.map { request ->
            val previousFingerprint = priorResults[request.key]?.fingerprint ?: fingerprintsInBatch[request.key]
            if (previousFingerprint != null) {
                SendDecision.Repeated(request, previousFingerprint)
            } else {
                fingerprintsInBatch[request.key] = request.fingerprint
                val reason = requestRejections[request.key] ?: context.rejection(request)
                if (reason != null) SendDecision.Rejected(request, reason) else SendDecision.Accepted(request)
            }
        }
    }

    private fun recordDecisions(decisions: List<SendDecision>, context: ChatContext): List<CommandResult> {
        val results = decisions.map { decision ->
            when (decision) {
                is SendDecision.Repeated -> duplicateOutcome(decision.request, decision.previousFingerprint)
                is SendDecision.Rejected -> rejectedOutcome(decision.request, decision.reason)
                is SendDecision.Accepted -> CommandResult.SAVED
            }
        }
        val accepted = decisions.filterIsInstance<SendDecision.Accepted>().map { it.request }
        if (accepted.isNotEmpty()) saveAccepted(checkNotNull(context.chat), accepted, context)
        return results
    }

    private fun saveAccepted(chat: Chat, accepted: List<SendRequest>, context: ChatContext) {
        val firstSequence = checkNotNull(chatRepository.allocateSequencesForMembers(chat.id, accepted.map { it.senderId })) {
            "Chat membership changed during a locked send batch"
        }
        SendStageRecorder.requests(SendStage.SEQUENCES_ALLOCATED, accepted) { it.requestId.value }
        val rooms = roomsFor(chat)
        val pending = accepted.mapIndexed { index, request ->
            prepareMessage(
                request = request,
                chat = chat,
                sequence = firstSequence + index,
                rooms = rooms,
                reply = context.replyTarget(request),
                forwarded = context.forwardSource(request),
            )
        }
        messageRepository.insertSavedMessages(pending.map { it.saved })
        SendStageRecorder.requests(SendStage.MESSAGES_RESULTS_WRITTEN, accepted) { it.requestId.value }
        outboxRepository.enqueue(pending.flatMap { it.events })
        SendStageRecorder.requests(SendStage.OUTBOX_WRITTEN, accepted) { it.requestId.value }
    }

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
        messageRepository.insertSendResult(rejected(request, reason))
        SendStageRecorder.record(SendStage.MESSAGES_RESULTS_WRITTEN, requestId = request.requestId.value)
        enqueueRejection(request = request, reason = reason)
        return CommandResult.REJECTED
    }

    private fun prepareMessage(
        request: SendRequest,
        chat: Chat,
        sequence: Long,
        rooms: List<String>,
        reply: MessageReply?,
        forwarded: Message?,
    ): PendingMessage {
        val chatId = chat.id
        val now = OffsetDateTime.now(clock)
        val messageId = MessageId(newId())
        val message = Message(
            id = messageId,
            chatId = chatId,
            sequence = sequence,
            senderId = request.senderId,
            body = forwarded?.body ?: request.body,
            createdAt = now,
            reply = reply,
            forwardedFromUserId = forwarded?.let { it.forwardedFromUserId ?: it.senderId },
        )
        val saved = SavedMessage(
            message,
            SendResult(
                senderId = request.senderId,
                requestId = request.requestId,
                chatId = chatId,
                recipientId = request.recipientId,
                fingerprint = request.fingerprint,
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
                requestId = request.requestId.value,
                messageId = messageId.value,
                sequence = sequence.toString(),
            )
        }
        if (SendStageRecorder.isEnabled) {
            events.forEach { event ->
                SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = request.requestId.value, eventId = event.eventId)
            }
        }
        return PendingMessage(
            saved,
            events.map { it.toOutboxMessage(mapper) },
        )
    }

    private fun rejected(request: SendRequest, reason: SendRejectionReason) = SendResult(
        senderId = request.senderId,
        requestId = request.requestId,
        chatId = request.chatId,
        recipientId = request.recipientId,
        fingerprint = request.fingerprint,
        status = SendResultStatus.REJECTED,
        messageId = null,
        sequence = null,
        reason = reason,
    )

    private fun enqueueRejection(request: SendRequest, reason: SendRejectionReason) {
        enqueue(
            SendRejectedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(request.senderId),
                chatId = request.chatId?.value,
                recipientId = request.recipientId?.value,
                requestId = request.requestId.value,
                reason = reason,
            ),
        )
    }

    private fun enqueue(event: SendRejectedEventV1) {
        SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = event.requestId, eventId = event.eventId)
        outboxRepository.enqueue(event.toOutboxMessage(mapper))
        SendStageRecorder.record(SendStage.OUTBOX_WRITTEN, requestId = event.requestId, eventId = event.eventId)
    }

    private class ChatContext(
        val chat: Chat?,
        val members: Set<UserId>,
        val replyTargets: Map<Pair<UserId, MessageId>, Message>,
        val forwardSources: Map<Pair<UserId, ForwardSource>, Message>,
    ) {
        fun rejection(request: SendRequest): SendRejectionReason? = when {
            chat == null -> SendRejectionReason.CHAT_NOT_FOUND
            request.senderId !in members -> SendRejectionReason.NOT_A_MEMBER
            request.forwardSource != null && request.replyToMessageId != null -> SendRejectionReason.INVALID_FORWARD_SOURCE
            request.replyToMessageId != null && replyTarget(request) == null -> SendRejectionReason.INVALID_REPLY_TARGET
            request.forwardSource != null && forwardSource(request) == null -> SendRejectionReason.INVALID_FORWARD_SOURCE
            else -> null
        }

        fun replyTarget(request: SendRequest): MessageReply? =
            request.replyToMessageId?.let { replyTargets[request.senderId to it] }?.asReply()

        fun forwardSource(request: SendRequest): Message? = request.forwardSource?.let { forwardSources[request.senderId to it] }
    }

    private sealed interface SendDecision {
        val request: SendRequest

        data class Repeated(
            override val request: SendRequest,
            val previousFingerprint: String,
        ) : SendDecision

        data class Rejected(
            override val request: SendRequest,
            val reason: SendRejectionReason,
        ) : SendDecision

        data class Accepted(
            override val request: SendRequest,
        ) : SendDecision
    }

    private data class PendingMessage(
        val saved: SavedMessage,
        val events: List<OutboxMessage>,
    )
}
