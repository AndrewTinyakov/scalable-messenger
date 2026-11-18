package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.DirectChatService
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.message.messaging.MessageSendOutbox
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.ForwardSource
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.MessageReply
import com.andrewtinyakov.messenger.message.model.PendingMessage
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.model.SavedMessage
import com.andrewtinyakov.messenger.message.model.SendChatContext
import com.andrewtinyakov.messenger.message.model.SendDecision
import com.andrewtinyakov.messenger.message.model.SendRequest
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.model.SendTarget
import com.andrewtinyakov.messenger.message.model.toSendRequest
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics
import com.andrewtinyakov.messenger.message.monitoring.SendTransactionCompletion
import com.andrewtinyakov.messenger.message.monitoring.TransactionWindow
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Service
class MessageSendService(
    private val messageRepository: MessageRepository,
    private val chatRepository: ChatRepository,
    private val directChatService: DirectChatService,
    private val userRepository: UserRepository,
    private val messageSendOutbox: MessageSendOutbox,
    private val tx: TransactionTemplate,
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
        tx.executeWithoutResult {
            messageRepository.lockSend(senderId = request.senderId, requestId = request.requestId)
            if (messageRepository.findSendResult(senderId = request.senderId, requestId = request.requestId) == null) {
                val result = rejected(request, SendRejectionReason.PROCESSING_FAILED)
                messageRepository.insertSendResult(result)
                messageSendOutbox.enqueueRejection(request, result.reason!!)
            }
        }
    }

    internal fun processBatchInTransaction(commands: List<SendMessageCommandV1>): List<CommandResult> {
        check(TransactionSynchronizationManager.isActualTransactionActive()) { "Send batch requires an active transaction" }
        val requests = commands.map { it.toSendRequest() }
        lockRequests(requests)
        val window = metrics.transactionStarted(requests.size)
        SendTransactionCompletion.onCompletion { window.completed() }
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
            return tx.execute {
                SendTransactionCompletion.onCompletion { completion ->
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

    private fun inspectChat(chat: Chat?, requests: List<SendRequest>, sendable: List<SendRequest>): SendChatContext {
        val members = chat?.let { chatRepository.existingMemberIds(it.id, requests.map { request -> request.senderId }.distinct()) }
            .orEmpty()
        SendStageRecorder.requests(SendStage.MEMBERSHIP_CHECKED, requests) { it.requestId.value }
        val memberRequests = sendable.filter { it.senderId in members }
        return SendChatContext(
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
        context: SendChatContext,
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

    private fun recordDecisions(decisions: List<SendDecision>, context: SendChatContext): List<CommandResult> {
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

    private fun saveAccepted(chat: Chat, accepted: List<SendRequest>, context: SendChatContext) {
        val firstSequence = checkNotNull(chatRepository.allocateSequencesForMembers(chat.id, accepted.map { it.senderId })) {
            "Chat membership changed during a locked send batch"
        }
        SendStageRecorder.requests(SendStage.SEQUENCES_ALLOCATED, accepted) { it.requestId.value }
        val rooms = messageSendOutbox.rooms(chat)
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
        messageSendOutbox.enqueueSaved(pending.flatMap { it.events })
        SendStageRecorder.requests(SendStage.OUTBOX_WRITTEN, accepted) { it.requestId.value }
    }

    private fun duplicateOutcome(request: SendRequest, previousFingerprint: String): CommandResult {
        if (previousFingerprint == request.fingerprint) return CommandResult.DUPLICATE
        messageSendOutbox.enqueueRejection(request, SendRejectionReason.REQUEST_ID_CONFLICT)
        return CommandResult.CONFLICT
    }

    private fun rejectedOutcome(request: SendRequest, reason: SendRejectionReason): CommandResult {
        messageRepository.insertSendResult(rejected(request, reason))
        SendStageRecorder.record(SendStage.MESSAGES_RESULTS_WRITTEN, requestId = request.requestId.value)
        messageSendOutbox.enqueueRejection(request = request, reason = reason)
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
        return PendingMessage(
            saved,
            messageSendOutbox.savedReferences(request, chat, messageId, sequence, rooms),
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
}
