package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.ChatDeletedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.id.requireId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Duration

@Service
class DeletionService(
    private val repository: DeletionRepository,
    private val chats: ChatRepository,
    private val outbox: OutboxRepository,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
    private val metrics: MeterRegistry,
) {
    fun delete(
        chatId: ChatId,
        actorId: UserId,
        input: DeletionRequest,
        expectedVersions: Map<MessageId, Long> = emptyMap(),
    ): DeletionResponse {
        val sample = Timer.start(metrics)
        var outcome = "failed"
        try {
            val result = executeDeletion(chatId, actorId, input, expectedVersions)
            outcome = "success"
            return result
        } finally {
            sample.stop(
                Timer.builder(
                    "messenger.deletion.acceptance",
                ).tags("scope", input.scope.name.lowercase(), "target", input.target.name.lowercase(), "outcome", outcome)
                    .publishPercentileHistogram().minimumExpectedValue(
                        Duration.ofMillis(1),
                    ).maximumExpectedValue(Duration.ofSeconds(30)).register(metrics),
            )
        }
    }

    private fun executeDeletion(
        chatId: ChatId,
        actorId: UserId,
        input: DeletionRequest,
        expectedVersions: Map<MessageId, Long>,
    ): DeletionResponse {
        requireId(input.requestId)
        val ids = input.messageIds.orEmpty()
        if (input.target == DeletionTarget.MESSAGES) {
            if (ids.size !in 1..100 ||
                ids.size != ids.distinct().size
            ) {
                badRequest(ApiErrorCode.INVALID_REQUEST, "Provide 1 to 100 distinct message IDs")
            }
            ids.forEach(::requireId)
        } else if (input.messageIds != null) {
            badRequest(ApiErrorCode.INVALID_REQUEST, "messageIds is only valid for message deletion")
        }
        val fingerprint = sha256("${chatId.value}|${input.scope}|${input.target}|${ids.sorted().joinToString(",")}")
        return tx.observedExecute(DatabaseTransaction.DELETION_ACCEPT) {
            repository.lockRequest(actorId, input.requestId)
            repository.operation(chatId, actorId, input.requestId)?.let { existing ->
                if (existing.chatId != chatId.value ||
                    existing.fingerprint != fingerprint
                ) {
                    throw ApiException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "Deletion request ID changed")
                }
                return@observedExecute existing.response
            }
            val chat = repository.lockChat(chatId, actorId) ?: notFound()
            if (input.scope == DeletionScope.EVERYONE && input.target != DeletionTarget.MESSAGES && chat.kind == ChatKind.GROUP &&
                chat.owner != actorId
            ) {
                forbidden()
            }
            if (chat.deleted) {
                if (input.scope != DeletionScope.EVERYONE || input.target != DeletionTarget.CHAT) notFound()
                repository.repairClosedPurge(chatId, chat.high)
                repository.saveOperation(chatId, actorId, input, fingerprint, chat, chat.revision, chat.visibility, 0)
                return@observedExecute repository.operation(chatId, actorId, input.requestId)!!.response
            }
            val targets = if (input.target ==
                DeletionTarget.MESSAGES
            ) {
                repository.targets(chatId, actorId, ids.map(::MessageId), input.scope)
            } else {
                emptyList()
            }
            if (expectedVersions.any { (id, version) -> targets.singleOrNull { it.id == id }?.messageVersion != version }) {
                throw ApiException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "Message version changed")
            }
            if (input.scope == DeletionScope.EVERYONE && chat.kind == ChatKind.GROUP && chat.owner != actorId &&
                targets.any { it.senderId != actorId }
            ) {
                forbidden()
            }
            var revision = chat.revision
            var visibility = chat.visibility
            when (input.scope) {
                DeletionScope.SELF -> {
                    visibility =
                        if (input.target ==
                            DeletionTarget.MESSAGES
                        ) {
                            repository.hideMessages(chatId, actorId, targets)
                        } else {
                            repository.clearPersonal(
                                chatId,
                                actorId,
                                chat.high,
                                input.target == DeletionTarget.CHAT,
                            )
                        }
                }

                DeletionScope.EVERYONE -> {
                    revision =
                        if (input.target ==
                            DeletionTarget.MESSAGES
                        ) {
                            repository.removeMessages(chatId, targets)
                        } else {
                            repository.clearGlobal(
                                chatId,
                                actorId,
                                chat.high,
                                input.target == DeletionTarget.CHAT,
                            )
                        }
                }
            }
            repository.saveOperation(
                chatId,
                actorId,
                input,
                fingerprint,
                chat,
                revision,
                visibility,
                if (input.scope ==
                    DeletionScope.EVERYONE
                ) {
                    targets.size
                } else {
                    0
                },
            )
            val rooms = when {
                input.scope == DeletionScope.SELF -> listOf(RoomAddress.user(actorId))
                chat.kind == ChatKind.GROUP -> listOf(RoomAddress.group(chatId))
                else -> chats.findMemberIds(chatId).map(RoomAddress::user)
            }
            val notifications = rooms.map { room ->
                val event = HistoryChangedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chatId.value,
                    sequence = chat.high.toString(),
                    mutationRevision = revision.toString(),
                    visibilityRevision = if (input.scope ==
                        DeletionScope.SELF
                    ) {
                        visibility.toString()
                    } else {
                        "0"
                    },
                )
                OutboxMessage(EventId(event.eventId), room, mapper.writeValueAsString(event))
            }
            outbox.enqueue(notifications)
            if (input.scope == DeletionScope.EVERYONE && input.target == DeletionTarget.CHAT) {
                outbox.enqueue(
                    rooms.map { room ->
                        val event = ChatDeletedEventV1.create(eventId = newId(), room = room, chatId = chatId.value)
                        OutboxMessage(EventId(event.eventId), room, mapper.writeValueAsString(event))
                    },
                )
            }
            metrics.counter(
                "messenger.deletion.accepted",
                "scope",
                input.scope.name.lowercase(),
                "target",
                input.target.name.lowercase(),
            ).increment()
            repository.operation(chatId, actorId, input.requestId)!!.response
        }
    }

    fun status(chatId: ChatId, actorId: UserId, requestId: String): DeletionResponse =
        repository.operation(chatId, actorId, requestId)?.takeIf { it.chatId == chatId.value }?.response ?: notFound()

    private fun forbidden(): Nothing = throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, "This deletion is not permitted")
}
