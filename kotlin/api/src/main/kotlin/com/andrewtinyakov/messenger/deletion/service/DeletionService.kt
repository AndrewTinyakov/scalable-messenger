package com.andrewtinyakov.messenger.deletion.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.service.ChatEventAudience
import com.andrewtinyakov.messenger.deletion.model.DeletionChat
import com.andrewtinyakov.messenger.deletion.model.DeletionMessage
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.deletion.monitoring.DeletionMetrics
import com.andrewtinyakov.messenger.deletion.repository.DeletionRepository
import com.andrewtinyakov.messenger.deletion.web.payload.DeletionResponse
import com.andrewtinyakov.messenger.deletion.web.payload.toResponse
import com.andrewtinyakov.messenger.generated.messaging.event.ChatDeletedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper

@Service
class DeletionService(
    private val deletionRepository: DeletionRepository,
    private val chatEventAudience: ChatEventAudience,
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
    private val metrics: DeletionMetrics,
) {
    private data class CommittedDeletion(
        val response: DeletionResponse,
        val newlyAccepted: Boolean,
    )

    private data class DeletionRevisions(
        val mutation: Long,
        val visibility: Long,
    )

    private data class AppliedDeletion(
        val revisions: DeletionRevisions,
        val deletedRows: Int,
    )

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
                DeletionScope.SELF -> AppliedDeletion(
                    revisions = DeletionRevisions(
                        mutation = chat.mutationRevision,
                        visibility = deletionRepository.hideMessages(chatId, userId, targets),
                    ),
                    deletedRows = 0,
                )

                DeletionScope.EVERYONE -> AppliedDeletion(
                    revisions = DeletionRevisions(
                        mutation = deletionRepository.removeMessages(chatId, targets),
                        visibility = chat.visibilityRevision,
                    ),
                    deletedRows = targets.size,
                )
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
        val committed = tx.observedExecute(DatabaseTransaction.DELETION_ACCEPT) {
            deletionRepository.lockRequest(userId, requestId)
            replayExistingOperation(chatId, userId, requestId, fingerprint)?.let { return@observedExecute it }
            val chat = deletionRepository.lockChat(chatId, userId) ?: notFound()
            requireChatDeletionAllowed(chat, userId, scope, target)
            if (chat.deleted) return@observedExecute repairClosedChat(chatId, userId, requestId, scope, target, fingerprint, chat)
            val applied = applyDeletion(chat)
            deletionRepository.saveOperation(
                chatId = chatId,
                userId = userId,
                requestId = requestId,
                scope = scope,
                target = target,
                fingerprint = fingerprint,
                chat = chat,
                mutationRevision = applied.revisions.mutation,
                visibilityRevision = applied.revisions.visibility,
                rows = applied.deletedRows,
            )
            enqueueDeletionEvents(chatId, userId, scope, target, chat, applied.revisions)
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
        DeletionScope.SELF -> AppliedDeletion(
            revisions = DeletionRevisions(
                mutation = chat.mutationRevision,
                visibility = deletionRepository.clearPersonal(chatId, userId, through = chat.lastSequence, hide = wholeChat),
            ),
            deletedRows = 0,
        )

        DeletionScope.EVERYONE -> AppliedDeletion(
            revisions = DeletionRevisions(
                mutation = deletionRepository.clearGlobal(chatId, userId, through = chat.lastSequence, close = wholeChat),
                visibility = chat.visibilityRevision,
            ),
            deletedRows = 0,
        )
    }

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
            conflict(ApiErrorCode.INVALID_REQUEST, "Deletion request ID changed")
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
            mutationRevision = chat.mutationRevision,
            visibilityRevision = chat.visibilityRevision,
            rows = 0,
        )
        return CommittedDeletion(saved(userId, requestId).toResponse(), newlyAccepted = false)
    }

    private fun requireExpectedVersions(targets: List<DeletionMessage>, expectedVersions: Map<MessageId, Long>) {
        if (expectedVersions.any { (id, version) -> targets.singleOrNull { it.id == id }?.messageVersion != version }) {
            conflict(ApiErrorCode.INVALID_REQUEST, "Message version changed")
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
        revisions: DeletionRevisions,
    ) {
        val rooms = chatEventAudience.rooms(chatId, chat.kind, personalViewer = userId.takeIf { scope == DeletionScope.SELF })
        enqueueHistoryChanged(rooms, chatId, scope, chat, revisions)
        if (scope == DeletionScope.EVERYONE && target == DeletionTarget.CHAT) enqueueChatDeleted(rooms, chatId)
    }

    private fun enqueueHistoryChanged(
        rooms: List<String>,
        chatId: ChatId,
        scope: DeletionScope,
        chat: DeletionChat,
        revisions: DeletionRevisions,
    ) {
        outboxRepository.enqueue(
            rooms.map { room ->
                HistoryChangedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chatId.value,
                    sequence = chat.lastSequence.toString(),
                    mutationRevision = revisions.mutation.toString(),
                    visibilityRevision = if (scope == DeletionScope.SELF) revisions.visibility.toString() else "0",
                ).toOutboxMessage(mapper)
            },
        )
    }

    private fun enqueueChatDeleted(rooms: List<String>, chatId: ChatId) {
        outboxRepository.enqueue(
            rooms.map { room ->
                ChatDeletedEventV1.create(eventId = newId(), room = room, chatId = chatId.value).toOutboxMessage(mapper)
            },
        )
    }

    private fun saved(userId: UserId, requestId: RequestId): StoredDeletion = checkNotNull(deletionRepository.operation(userId, requestId))

    private fun forbiddenDeletion(): Nothing = forbidden("This deletion is not permitted")
}
