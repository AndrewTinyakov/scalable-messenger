package com.andrewtinyakov.messenger.chat.deletion.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionChat
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionCommand
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionMessage
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.chat.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.chat.deletion.monitoring.DeletionMetrics
import com.andrewtinyakov.messenger.chat.deletion.repository.DeletionRepository
import com.andrewtinyakov.messenger.chat.deletion.web.payload.DeletionResponse
import com.andrewtinyakov.messenger.chat.deletion.web.payload.toResponse
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.service.ChatEventAudience
import com.andrewtinyakov.messenger.generated.messaging.event.ChatDeletedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.model.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxRepository
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

    fun delete(
        chatId: ChatId,
        userId: UserId,
        command: DeletionCommand,
        expectedVersions: Map<MessageId, Long> = emptyMap(),
    ): DeletionResponse = metrics.timeAcceptance(command.scope, command.target) {
        val committed = executeDeletion(chatId, userId, command, expectedVersions)
        if (committed.newlyAccepted) metrics.accepted(command.scope, command.target)
        committed.response
    }

    private fun executeDeletion(
        chatId: ChatId,
        userId: UserId,
        command: DeletionCommand,
        expectedVersions: Map<MessageId, Long>,
    ): CommittedDeletion {
        val fingerprint = fingerprint(chatId, command)
        return tx.observedExecute(DatabaseTransaction.DELETION_ACCEPT) {
            deletionRepository.lockRequest(userId, command.requestId)
            replayExistingOperation(chatId, userId, command.requestId, fingerprint)?.let { return@observedExecute it }
            val chat = deletionRepository.lockChat(chatId, userId) ?: notFound()
            requireChatDeletionAllowed(chat, userId, command)
            if (chat.deleted) return@observedExecute repairClosedChat(chatId, userId, command, fingerprint, chat)
            val targets = findTargets(chatId, userId, command)
            requireExpectedVersions(targets, expectedVersions)
            requireMessageDeletionAllowed(chat, userId, command, targets)
            val revisions = applyDeletion(chatId, userId, command, chat, targets)
            saveOperation(chatId, userId, command, fingerprint, chat, revisions, rows = deletedRows(command, targets))
            enqueueDeletionEvents(chatId, userId, command, chat, revisions)
            CommittedDeletion(saved(userId, command.requestId).toResponse(), newlyAccepted = true)
        }
    }

    fun status(chatId: ChatId, userId: UserId, requestId: RequestId): DeletionResponse =
        deletionRepository.operation(userId, requestId)?.takeIf { it.chatId == chatId }?.toResponse() ?: notFound()

    private fun fingerprint(chatId: ChatId, command: DeletionCommand): String {
        val ids = command.messageIds.orEmpty()
        return sha256("${chatId.value}|${command.scope}|${command.target}|${ids.map { it.value }.sorted().joinToString(",")}")
    }

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

    private fun requireChatDeletionAllowed(chat: DeletionChat, userId: UserId, command: DeletionCommand) {
        if (command.scope == DeletionScope.EVERYONE &&
            command.target != DeletionTarget.MESSAGES &&
            chat.kind == ChatKind.GROUP &&
            chat.ownerId != userId
        ) {
            forbiddenDeletion()
        }
    }

    private fun repairClosedChat(
        chatId: ChatId,
        userId: UserId,
        command: DeletionCommand,
        fingerprint: String,
        chat: DeletionChat,
    ): CommittedDeletion {
        if (command.scope != DeletionScope.EVERYONE || command.target != DeletionTarget.CHAT) notFound()
        deletionRepository.repairClosedPurge(chatId, chat.lastSequence)
        saveOperation(
            chatId = chatId,
            userId = userId,
            command = command,
            fingerprint = fingerprint,
            chat = chat,
            revisions = DeletionRevisions(mutation = chat.mutationRevision, visibility = chat.visibilityRevision),
            rows = 0,
        )
        return CommittedDeletion(saved(userId, command.requestId).toResponse(), newlyAccepted = false)
    }

    private fun findTargets(chatId: ChatId, userId: UserId, command: DeletionCommand): List<DeletionMessage> =
        if (command.target == DeletionTarget.MESSAGES) {
            deletionRepository.targets(chatId, userId, command.messageIds.orEmpty(), command.scope)
        } else {
            emptyList()
        }

    private fun requireExpectedVersions(targets: List<DeletionMessage>, expectedVersions: Map<MessageId, Long>) {
        if (expectedVersions.any { (id, version) -> targets.singleOrNull { it.id == id }?.messageVersion != version }) {
            conflict(ApiErrorCode.INVALID_REQUEST, "Message version changed")
        }
    }

    private fun requireMessageDeletionAllowed(
        chat: DeletionChat,
        userId: UserId,
        command: DeletionCommand,
        targets: List<DeletionMessage>,
    ) {
        if (command.scope == DeletionScope.EVERYONE &&
            chat.kind == ChatKind.GROUP &&
            chat.ownerId != userId &&
            targets.any { it.senderId != userId }
        ) {
            forbiddenDeletion()
        }
    }

    private fun applyDeletion(
        chatId: ChatId,
        userId: UserId,
        command: DeletionCommand,
        chat: DeletionChat,
        targets: List<DeletionMessage>,
    ): DeletionRevisions = when (command.scope) {
        DeletionScope.SELF -> DeletionRevisions(
            mutation = chat.mutationRevision,
            visibility = applyPersonalDeletion(chatId, userId, command.target, chat, targets),
        )

        DeletionScope.EVERYONE -> DeletionRevisions(
            mutation = applyEveryoneDeletion(chatId, userId, command.target, chat, targets),
            visibility = chat.visibilityRevision,
        )
    }

    private fun applyPersonalDeletion(
        chatId: ChatId,
        userId: UserId,
        target: DeletionTarget,
        chat: DeletionChat,
        targets: List<DeletionMessage>,
    ): Long = if (target == DeletionTarget.MESSAGES) {
        deletionRepository.hideMessages(chatId, userId, targets)
    } else {
        deletionRepository.clearPersonal(
            chatId = chatId,
            userId = userId,
            through = chat.lastSequence,
            hide = target == DeletionTarget.CHAT,
        )
    }

    private fun applyEveryoneDeletion(
        chatId: ChatId,
        userId: UserId,
        target: DeletionTarget,
        chat: DeletionChat,
        targets: List<DeletionMessage>,
    ): Long = if (target == DeletionTarget.MESSAGES) {
        deletionRepository.removeMessages(chatId, targets)
    } else {
        deletionRepository.clearGlobal(
            chatId = chatId,
            userId = userId,
            through = chat.lastSequence,
            close = target == DeletionTarget.CHAT,
        )
    }

    private fun deletedRows(command: DeletionCommand, targets: List<DeletionMessage>): Int =
        if (command.scope == DeletionScope.EVERYONE) targets.size else 0

    private fun saveOperation(
        chatId: ChatId,
        userId: UserId,
        command: DeletionCommand,
        fingerprint: String,
        chat: DeletionChat,
        revisions: DeletionRevisions,
        rows: Int,
    ) = deletionRepository.saveOperation(
        chatId = chatId,
        userId = userId,
        command = command,
        fingerprint = fingerprint,
        chat = chat,
        mutationRevision = revisions.mutation,
        visibilityRevision = revisions.visibility,
        rows = rows,
    )

    private fun enqueueDeletionEvents(
        chatId: ChatId,
        userId: UserId,
        command: DeletionCommand,
        chat: DeletionChat,
        revisions: DeletionRevisions,
    ) {
        val rooms = chatEventAudience.rooms(chatId, chat.kind, personalViewer = userId.takeIf { command.scope == DeletionScope.SELF })
        enqueueHistoryChanged(
            rooms = rooms,
            chatId = chatId,
            scope = command.scope,
            chat = chat,
            revisions = revisions,
        )
        if (command.scope == DeletionScope.EVERYONE && command.target == DeletionTarget.CHAT) enqueueChatDeleted(rooms, chatId)
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
