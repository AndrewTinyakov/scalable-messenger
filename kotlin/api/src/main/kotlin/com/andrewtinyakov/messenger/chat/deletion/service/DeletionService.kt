package com.andrewtinyakov.messenger.chat.deletion.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionCommand
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
        val ids = command.messageIds.orEmpty()
        val fingerprint = sha256("${chatId.value}|${command.scope}|${command.target}|${ids.map { it.value }.sorted().joinToString(",")}")
        return tx.observedExecute(DatabaseTransaction.DELETION_ACCEPT) {
            repository.lockRequest(actorId, command.requestId)
            repository.operation(actorId, command.requestId)?.let { existing ->
                if (existing.chatId != chatId ||
                    existing.fingerprint != fingerprint
                ) {
                    conflict(ApiErrorCode.INVALID_REQUEST, "Deletion request ID changed")
                }
                return@observedExecute CommittedDeletion(existing.toResponse(), newlyAccepted = false)
            }
            val chat = repository.lockChat(chatId, actorId) ?: notFound()
            if (command.scope == DeletionScope.EVERYONE && command.target != DeletionTarget.MESSAGES && chat.kind == ChatKind.GROUP &&
                chat.owner != actorId
            ) {
                forbiddenDeletion()
            }
            if (chat.deleted) {
                if (command.scope != DeletionScope.EVERYONE || command.target != DeletionTarget.CHAT) notFound()
                repository.repairClosedPurge(chatId, chat.high)
                repository.saveOperation(
                    chatId = chatId,
                    actorId = actorId,
                    command = command,
                    fingerprint = fingerprint,
                    chat = chat,
                    revision = chat.revision,
                    visibility = chat.visibility,
                    rows = 0,
                )
                return@observedExecute CommittedDeletion(saved(actorId, command.requestId).toResponse(), newlyAccepted = false)
            }
            val targets = if (command.target == DeletionTarget.MESSAGES) {
                repository.targets(chatId, actorId, ids, command.scope)
            } else {
                emptyList()
            }
            if (expectedVersions.any { (id, version) -> targets.singleOrNull { it.id == id }?.messageVersion != version }) {
                conflict(ApiErrorCode.INVALID_REQUEST, "Message version changed")
            }
            if (command.scope == DeletionScope.EVERYONE && chat.kind == ChatKind.GROUP && chat.owner != actorId &&
                targets.any { it.senderId != actorId }
            ) {
                forbiddenDeletion()
            }
            var revision = chat.revision
            var visibility = chat.visibility
            when (command.scope) {
                DeletionScope.SELF -> {
                    visibility =
                        if (command.target == DeletionTarget.MESSAGES) {
                            repository.hideMessages(chatId, actorId, targets)
                        } else {
                            repository.clearPersonal(
                                chatId = chatId,
                                actorId = actorId,
                                through = chat.high,
                                hide = command.target == DeletionTarget.CHAT,
                            )
                        }
                }

                DeletionScope.EVERYONE -> {
                    revision =
                        if (command.target == DeletionTarget.MESSAGES) {
                            repository.removeMessages(chatId, targets)
                        } else {
                            repository.clearGlobal(
                                chatId = chatId,
                                actorId = actorId,
                                through = chat.high,
                                close = command.target == DeletionTarget.CHAT,
                            )
                        }
                }
            }
            repository.saveOperation(
                chatId = chatId,
                actorId = actorId,
                command = command,
                fingerprint = fingerprint,
                chat = chat,
                revision = revision,
                visibility = visibility,
                rows = if (command.scope == DeletionScope.EVERYONE) {
                    targets.size
                } else {
                    0
                },
            )
            val rooms = audience.rooms(chatId, chat.kind, personalViewer = actorId.takeIf { command.scope == DeletionScope.SELF })
            outbox.enqueue(
                rooms.map { room ->
                    HistoryChangedEventV1.create(
                        eventId = newId(),
                        room = room,
                        chatId = chatId.value,
                        sequence = chat.high.toString(),
                        mutationRevision = revision.toString(),
                        visibilityRevision = if (command.scope == DeletionScope.SELF) {
                            visibility.toString()
                        } else {
                            "0"
                        },
                    ).toOutboxMessage(mapper)
                },
            )
            if (command.scope == DeletionScope.EVERYONE && command.target == DeletionTarget.CHAT) {
                outbox.enqueue(
                    rooms.map { room ->
                        ChatDeletedEventV1.create(eventId = newId(), room = room, chatId = chatId.value).toOutboxMessage(mapper)
                    },
                )
            }
            CommittedDeletion(saved(actorId, command.requestId).toResponse(), newlyAccepted = true)
        }
    }

    fun status(chatId: ChatId, actorId: UserId, requestId: RequestId): DeletionResponse =
        repository.operation(actorId, requestId)?.takeIf { it.chatId == chatId }?.toResponse() ?: notFound()

    private fun saved(actorId: UserId, requestId: RequestId): StoredDeletion = checkNotNull(repository.operation(actorId, requestId))

    private fun forbiddenDeletion(): Nothing = forbidden("This deletion is not permitted")
}
