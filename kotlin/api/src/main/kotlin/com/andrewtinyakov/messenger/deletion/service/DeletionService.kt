package com.andrewtinyakov.messenger.deletion.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.messaging.ChatEventAudience
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.deletion.messaging.DeletionOutbox
import com.andrewtinyakov.messenger.deletion.model.AppliedDeletion
import com.andrewtinyakov.messenger.deletion.model.CommittedDeletion
import com.andrewtinyakov.messenger.deletion.model.DeletionChat
import com.andrewtinyakov.messenger.deletion.model.DeletionMessage
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionSequences
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.deletion.monitoring.DeletionMetrics
import com.andrewtinyakov.messenger.deletion.repository.DeletionRepository
import com.andrewtinyakov.messenger.deletion.web.payload.DeletionResponse
import com.andrewtinyakov.messenger.deletion.web.payload.toResponse
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate

@Service
class DeletionService(
    private val deletionRepository: DeletionRepository,
    private val chatRepository: ChatRepository,
    private val chatEventAudience: ChatEventAudience,
    private val deletionOutbox: DeletionOutbox,
    private val tx: TransactionTemplate,
    private val metrics: DeletionMetrics,
) {
    fun deleteMessages(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        scope: DeletionScope,
        messageIds: List<MessageId>,
        expectedVersions: Map<MessageId, Long> = emptyMap(),
    ): DeletionResponse {
        require(messageIds.size in 1..DeletionMessage.MAX_PER_REQUEST && messageIds.distinct().size == messageIds.size)
        return accept(chatId, userId, requestId, scope, DeletionTarget.MESSAGES, messageIds) { chat ->
            val targets = deletionRepository.targets(chatId, userId, messageIds, scope)
            requireExpectedVersions(targets, expectedVersions)
            requireMessageDeletionAllowed(chat, userId, scope, targets)
            when (scope) {
                DeletionScope.SELF -> {
                    deletionRepository.hideMessages(chatId, userId, targets)
                    AppliedDeletion(
                        DeletionSequences(seq = chat.lastSequence, memberSeq = nextMemberSequence(chatId, userId)),
                        deletedRows = 0,
                    )
                }

                DeletionScope.EVERYONE -> {
                    val seq = nextChatSequence(chatId, userId)
                    deletionRepository.removeMessages(chatId, targets, seq)
                    AppliedDeletion(DeletionSequences(seq = seq, memberSeq = chat.memberSeq), deletedRows = targets.size)
                }
            }
        }
    }

    fun clearHistory(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        scope: DeletionScope,
    ): DeletionResponse = accept(chatId, userId, requestId, scope, DeletionTarget.HISTORY, emptyList()) { chat ->
        clearThroughLatest(chatId, userId, scope, chat, wholeChat = false)
    }

    fun deleteChat(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        scope: DeletionScope,
    ): DeletionResponse = accept(chatId, userId, requestId, scope, DeletionTarget.CHAT, emptyList()) { chat ->
        clearThroughLatest(chatId, userId, scope, chat, wholeChat = true)
    }

    fun status(chatId: ChatId, userId: UserId, requestId: RequestId): DeletionResponse =
        deletionRepository.operation(userId, requestId)?.takeIf { it.chatId == chatId }?.toResponse() ?: notFound()

    private fun accept(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        scope: DeletionScope,
        target: DeletionTarget,
        messageIds: List<MessageId>,
        applyDeletion: (DeletionChat) -> AppliedDeletion,
    ): DeletionResponse = metrics.timeAcceptance(scope, target) {
        val fingerprint = fingerprint(chatId, scope, target, messageIds)
        val committed = tx.execute {
            deletionRepository.lockRequest(userId, requestId)
            replayExistingOperation(chatId, userId, requestId, fingerprint)?.let { return@execute it }
            val chat = deletionRepository.lockChat(chatId, userId) ?: notFound()
            requireChatDeletionAllowed(chat, userId, scope, target)
            if (chat.deleted) return@execute repairClosedChat(chatId, userId, requestId, scope, target, fingerprint, chat)
            val applied = applyDeletion(chat)
            deletionRepository.saveOperation(
                chatId = chatId,
                userId = userId,
                requestId = requestId,
                scope = scope,
                target = target,
                fingerprint = fingerprint,
                chat = chat,
                sequences = applied.sequences,
                rows = applied.deletedRows,
            )
            enqueueDeletionEvents(chatId, userId, scope, target, chat, applied.sequences)
            CommittedDeletion(saved(userId, requestId).toResponse(), newlyAccepted = true)
        }
        if (committed.newlyAccepted) metrics.accepted(scope, target)
        committed.response
    }

    private fun clearThroughLatest(
        chatId: ChatId,
        userId: UserId,
        scope: DeletionScope,
        chat: DeletionChat,
        wholeChat: Boolean,
    ): AppliedDeletion = when (scope) {
        DeletionScope.SELF -> {
            deletionRepository.clearPersonal(chatId, userId, through = chat.lastSequence, hide = wholeChat)
            AppliedDeletion(DeletionSequences(seq = chat.lastSequence, memberSeq = nextMemberSequence(chatId, userId)), deletedRows = 0)
        }

        DeletionScope.EVERYONE -> {
            val seq = nextChatSequence(chatId, userId)
            deletionRepository.clearGlobal(chatId, userId, through = chat.lastSequence, close = wholeChat, seq = seq)
            AppliedDeletion(DeletionSequences(seq = seq, memberSeq = chat.memberSeq), deletedRows = 0)
        }
    }

    private fun nextChatSequence(chatId: ChatId, userId: UserId): Long = chatRepository.allocateEventSequence(chatId, userId) ?: notFound()

    private fun nextMemberSequence(chatId: ChatId, userId: UserId): Long =
        chatRepository.allocateMemberSequence(chatId, userId) ?: notFound()

    private fun fingerprint(
        chatId: ChatId,
        scope: DeletionScope,
        target: DeletionTarget,
        messageIds: List<MessageId>,
    ): String = sha256("${chatId.value}|$scope|$target|${messageIds.map { it.value }.sorted().joinToString(",")}")

    private fun replayExistingOperation(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        fingerprint: String,
    ): CommittedDeletion? {
        val existing = deletionRepository.operation(userId, requestId) ?: return null
        if (existing.chatId != chatId || existing.fingerprint != fingerprint) {
            conflict(ApiErrorCode.REQUEST_ID_REUSED, "Deletion request ID changed")
        }
        return CommittedDeletion(existing.toResponse(), newlyAccepted = false)
    }

    private fun requireChatDeletionAllowed(
        chat: DeletionChat,
        userId: UserId,
        scope: DeletionScope,
        target: DeletionTarget,
    ) {
        if (scope == DeletionScope.EVERYONE &&
            target != DeletionTarget.MESSAGES &&
            chat.kind == ChatKind.GROUP &&
            chat.ownerId != userId
        ) {
            forbiddenDeletion()
        }
    }

    private fun repairClosedChat(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        scope: DeletionScope,
        target: DeletionTarget,
        fingerprint: String,
        chat: DeletionChat,
    ): CommittedDeletion {
        if (scope != DeletionScope.EVERYONE || target != DeletionTarget.CHAT) notFound()
        deletionRepository.repairClosedPurge(chatId, chat.lastSequence)
        deletionRepository.saveOperation(
            chatId = chatId,
            userId = userId,
            requestId = requestId,
            scope = scope,
            target = target,
            fingerprint = fingerprint,
            chat = chat,
            sequences = DeletionSequences(seq = chat.lastSequence, memberSeq = chat.memberSeq),
            rows = 0,
        )
        return CommittedDeletion(saved(userId, requestId).toResponse(), newlyAccepted = false)
    }

    private fun requireExpectedVersions(targets: List<DeletionMessage>, expectedVersions: Map<MessageId, Long>) {
        if (expectedVersions.any { (id, version) -> targets.singleOrNull { it.id == id }?.messageVersion != version }) {
            conflict(ApiErrorCode.VERSION_CHANGED, "Message version changed")
        }
    }

    private fun requireMessageDeletionAllowed(
        chat: DeletionChat,
        userId: UserId,
        scope: DeletionScope,
        targets: List<DeletionMessage>,
    ) {
        if (scope == DeletionScope.EVERYONE &&
            chat.kind == ChatKind.GROUP &&
            chat.ownerId != userId &&
            targets.any { it.senderId != userId }
        ) {
            forbiddenDeletion()
        }
    }

    private fun enqueueDeletionEvents(
        chatId: ChatId,
        userId: UserId,
        scope: DeletionScope,
        target: DeletionTarget,
        chat: DeletionChat,
        sequences: DeletionSequences,
    ) {
        val rooms = chatEventAudience.rooms(chatId, chat.kind, personalViewer = userId.takeIf { scope == DeletionScope.SELF })
        deletionOutbox.enqueueHistoryChanged(rooms, chatId, scope, sequences)
        if (scope == DeletionScope.EVERYONE &&
            target == DeletionTarget.CHAT
        ) {
            deletionOutbox.enqueueChatDeleted(rooms, chatId, sequences.seq)
        }
    }

    private fun saved(userId: UserId, requestId: RequestId): StoredDeletion = checkNotNull(deletionRepository.operation(userId, requestId))

    private fun forbiddenDeletion(): Nothing = forbidden("This deletion is not permitted")
}
