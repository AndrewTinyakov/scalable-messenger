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
    private val repository: DeletionRepository,
    private val audience: ChatEventAudience,
    private val outbox: OutboxRepository,
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
        actorId: UserId,
        command: DeletionCommand,
        expectedVersions: Map<MessageId, Long> = emptyMap(),
    ): DeletionResponse = metrics.timeAcceptance(command.scope, command.target) {
        val committed = executeDeletion(chatId, actorId, command, expectedVersions)
        if (committed.newlyAccepted) metrics.accepted(command.scope, command.target)
        committed.response
    }

    private fun executeDeletion(
        chatId: ChatId,
        actorId: UserId,
        command: DeletionCommand,
        expectedVersions: Map<MessageId, Long>,
    ): CommittedDeletion {
        val fingerprint = fingerprint(chatId, command)
        return tx.observedExecute(DatabaseTransaction.DELETION_ACCEPT) {
            repository.lockRequest(actorId, command.requestId)
            replayExistingOperation(chatId, actorId, command.requestId, fingerprint)?.let { return@observedExecute it }
            val chat = repository.lockChat(chatId, actorId) ?: notFound()
            requireChatDeletionAllowed(chat, actorId, command)
            if (chat.deleted) return@observedExecute repairClosedChat(chatId, actorId, command, fingerprint, chat)
            val targets = findTargets(chatId, actorId, command)
            requireExpectedVersions(targets, expectedVersions)
            requireMessageDeletionAllowed(chat, actorId, command, targets)
            val revisions = applyDeletion(chatId, actorId, command, chat, targets)
            saveOperation(chatId, actorId, command, fingerprint, chat, revisions, rows = deletedRows(command, targets))
            enqueueDeletionEvents(chatId, actorId, command, chat, revisions)
            CommittedDeletion(saved(actorId, command.requestId).toResponse(), newlyAccepted = true)
        }
    }

    fun status(chatId: ChatId, actorId: UserId, requestId: RequestId): DeletionResponse =
        repository.operation(actorId, requestId)?.takeIf { it.chatId == chatId }?.toResponse() ?: notFound()

    private fun fingerprint(chatId: ChatId, command: DeletionCommand): String {
        val ids = command.messageIds.orEmpty()
        return sha256("${chatId.value}|${command.scope}|${command.target}|${ids.map { it.value }.sorted().joinToString(",")}")
    }

    private fun replayExistingOperation(
        chatId: ChatId,
        actorId: UserId,
        requestId: RequestId,
        fingerprint: String,
    ): CommittedDeletion? {
        val existing = repository.operation(actorId, requestId) ?: return null
        if (existing.chatId != chatId || existing.fingerprint != fingerprint) {
            conflict(ApiErrorCode.INVALID_REQUEST, "Deletion request ID changed")
        }
        return CommittedDeletion(existing.toResponse(), newlyAccepted = false)
    }

    private fun requireChatDeletionAllowed(chat: DeletionChat, actorId: UserId, command: DeletionCommand) {
        if (command.scope == DeletionScope.EVERYONE &&
            command.target != DeletionTarget.MESSAGES &&
            chat.kind == ChatKind.GROUP &&
            chat.owner != actorId
        ) {
            forbiddenDeletion()
        }
    }

    private fun repairClosedChat(
        chatId: ChatId,
        actorId: UserId,
        command: DeletionCommand,
        fingerprint: String,
        chat: DeletionChat,
    ): CommittedDeletion {
        if (command.scope != DeletionScope.EVERYONE || command.target != DeletionTarget.CHAT) notFound()
        repository.repairClosedPurge(chatId, chat.high)
        saveOperation(
            chatId = chatId,
            actorId = actorId,
            command = command,
            fingerprint = fingerprint,
            chat = chat,
            revisions = DeletionRevisions(mutation = chat.revision, visibility = chat.visibility),
            rows = 0,
        )
        return CommittedDeletion(saved(actorId, command.requestId).toResponse(), newlyAccepted = false)
    }

    private fun findTargets(chatId: ChatId, actorId: UserId, command: DeletionCommand): List<DeletionMessage> =
        if (command.target == DeletionTarget.MESSAGES) {
            repository.targets(chatId, actorId, command.messageIds.orEmpty(), command.scope)
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
        actorId: UserId,
        command: DeletionCommand,
        targets: List<DeletionMessage>,
    ) {
        if (command.scope == DeletionScope.EVERYONE &&
            chat.kind == ChatKind.GROUP &&
            chat.owner != actorId &&
            targets.any { it.senderId != actorId }
        ) {
            forbiddenDeletion()
        }
    }

    private fun applyDeletion(
        chatId: ChatId,
        actorId: UserId,
        command: DeletionCommand,
        chat: DeletionChat,
        targets: List<DeletionMessage>,
    ): DeletionRevisions = when (command.scope) {
        DeletionScope.SELF -> DeletionRevisions(
            mutation = chat.revision,
            visibility = applyPersonalDeletion(chatId, actorId, command.target, chat, targets),
        )

        DeletionScope.EVERYONE -> DeletionRevisions(
            mutation = applyEveryoneDeletion(chatId, actorId, command.target, chat, targets),
            visibility = chat.visibility,
        )
    }

    private fun applyPersonalDeletion(
        chatId: ChatId,
        actorId: UserId,
        target: DeletionTarget,
        chat: DeletionChat,
        targets: List<DeletionMessage>,
    ): Long = if (target == DeletionTarget.MESSAGES) {
        repository.hideMessages(chatId, actorId, targets)
    } else {
        repository.clearPersonal(
            chatId = chatId,
            actorId = actorId,
            through = chat.high,
            hide = target == DeletionTarget.CHAT,
        )
    }

    private fun applyEveryoneDeletion(
        chatId: ChatId,
        actorId: UserId,
        target: DeletionTarget,
        chat: DeletionChat,
        targets: List<DeletionMessage>,
    ): Long = if (target == DeletionTarget.MESSAGES) {
        repository.removeMessages(chatId, targets)
    } else {
        repository.clearGlobal(
            chatId = chatId,
            actorId = actorId,
            through = chat.high,
            close = target == DeletionTarget.CHAT,
        )
    }

    private fun deletedRows(command: DeletionCommand, targets: List<DeletionMessage>): Int =
        if (command.scope == DeletionScope.EVERYONE) targets.size else 0

    private fun saveOperation(
        chatId: ChatId,
        actorId: UserId,
        command: DeletionCommand,
        fingerprint: String,
        chat: DeletionChat,
        revisions: DeletionRevisions,
        rows: Int,
    ) = repository.saveOperation(
        chatId = chatId,
        actorId = actorId,
        command = command,
        fingerprint = fingerprint,
        chat = chat,
        revision = revisions.mutation,
        visibility = revisions.visibility,
        rows = rows,
    )

    private fun enqueueDeletionEvents(
        chatId: ChatId,
        actorId: UserId,
        command: DeletionCommand,
        chat: DeletionChat,
        revisions: DeletionRevisions,
    ) {
        val rooms = audience.rooms(chatId, chat.kind, personalViewer = actorId.takeIf { command.scope == DeletionScope.SELF })
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
        outbox.enqueue(
            rooms.map { room ->
                HistoryChangedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chatId.value,
                    sequence = chat.high.toString(),
                    mutationRevision = revisions.mutation.toString(),
                    visibilityRevision = if (scope == DeletionScope.SELF) revisions.visibility.toString() else "0",
                ).toOutboxMessage(mapper)
            },
        )
    }

    private fun enqueueChatDeleted(rooms: List<String>, chatId: ChatId) {
        outbox.enqueue(
            rooms.map { room ->
                ChatDeletedEventV1.create(eventId = newId(), room = room, chatId = chatId.value).toOutboxMessage(mapper)
            },
        )
    }

    private fun saved(actorId: UserId, requestId: RequestId): StoredDeletion = checkNotNull(repository.operation(actorId, requestId))

    private fun forbiddenDeletion(): Nothing = forbidden("This deletion is not permitted")
}
