package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.deletion.ChatDeletionRepository
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.ChatDeletedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.notFound
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime

@Service
class ChatDeletionService(
    private val repository: ChatDeletionRepository,
    private val chats: ChatRepository,
    private val outbox: OutboxRepository,
    private val tx: TransactionTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
    private val metrics: MeterRegistry,
) {
    fun delete(chatId: ChatId, userId: UserId) {
        var outcome = "failed"
        try {
            tx.observedExecuteWithoutResult(DatabaseTransaction.CHAT_DELETE) {
                val chat = repository.lockForMember(chatId, userId) ?: notFound()
                if (chat.kind == ChatKind.GROUP && chat.ownerId != userId) {
                    outcome = "forbidden"
                    throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, "Only the group creator can delete the chat")
                }
                if (chat.deleted) return@observedExecuteWithoutResult
                val rooms = if (chat.kind == ChatKind.GROUP) {
                    listOf(RoomAddress.group(chatId))
                } else {
                    chats.findMemberIds(chatId).map(RoomAddress::user)
                }
                repository.delete(chatId, userId, OffsetDateTime.now(clock))
                outbox.enqueue(
                    rooms.map { room ->
                        val event = ChatDeletedEventV1.create(eventId = newId(), room = room, chatId = chatId.value)
                        OutboxMessage(EventId(event.eventId), event.room, mapper.writeValueAsString(event))
                    },
                )
            }
            outcome = "success"
        } finally {
            metrics.counter("messenger.chat.deletions", "outcome", outcome).increment()
        }
    }
}
