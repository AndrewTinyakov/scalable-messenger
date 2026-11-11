package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.ReadsChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.model.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.read.model.ReadAdvance
import com.andrewtinyakov.messenger.read.monitoring.ReadMetrics
import com.andrewtinyakov.messenger.read.repository.ReadRepository
import com.andrewtinyakov.messenger.read.web.payload.AdvanceReadRequest
import com.andrewtinyakov.messenger.read.web.payload.MessageReaderResponse
import com.andrewtinyakov.messenger.read.web.payload.MessageReadsResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadProgressResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadSummaryResponse
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.parseSequence
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime
import java.time.ZoneOffset

@Service
class ReadService(
    private val repository: ReadRepository,
    private val outbox: OutboxRepository,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: ReadMetrics,
) {
    private data class CommittedAdvance(
        val advance: ReadAdvance,
        val notificationCoalesced: Boolean,
    )

    fun advance(chatId: ChatId, userId: UserId, input: AdvanceReadRequest): ReadProgressResponse {
        val committed = tx.observedExecute(DatabaseTransaction.READ_ADVANCE) {
            val lastSequence = repository.requireMember(chatId, userId)
            val sequence = parseSequence(input.throughSequence)
                ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "throughSequence must be a nonnegative decimal integer")
            if (sequence > lastSequence) badRequest(ApiErrorCode.INVALID_SEQUENCE, "throughSequence exceeds saved history")
            val advance = repository.advance(chatId, userId, sequence)
            if (!advance.advanced) return@observedExecute CommittedAdvance(advance, notificationCoalesced = false)
            val sharedRooms = repository.notificationRooms(chatId, advance.progress.readAt!!)
            if (sharedRooms.isNotEmpty()) repository.completeNotification(chatId, userId)
            publishReadsChanged(chatId, (sharedRooms + RoomAddress.user(userId)).distinct())
            CommittedAdvance(advance, notificationCoalesced = sharedRooms.isEmpty())
        }
        val advance = committed.advance
        if (advance.advanced) metrics.advanced(advance.rangesWritten, committed.notificationCoalesced) else metrics.unchanged()
        return ReadProgressResponse(advance.progress.throughSequence.toString(), advance.progress.readAt, OffsetDateTime.now(clock))
    }

    fun publishPendingNotifications() {
        tx.observedExecute(DatabaseTransaction.READ_ADVANCE) {
            repository.pendingNotifications(OffsetDateTime.now(clock), 500).forEach { (chatId, rooms) ->
                publishReadsChanged(chatId, rooms)
            }
        }
    }

    fun summary(chatId: ChatId, userId: UserId): ReadSummaryResponse {
        val summary = repository.summary(chatId, userId) ?: notFound()
        return ReadSummaryResponse(summary.throughSequence.toString(), summary.maxOtherReadSequence.toString(), OffsetDateTime.now(clock))
    }

    fun readers(chatId: ChatId, userId: UserId, messageId: MessageId, afterUserId: String?, limit: Int): MessageReadsResponse {
        val target = repository.messageTarget(chatId, userId, messageId) ?: notFound()
        requirePageLimit(limit)
        val after = afterUserId?.let { UserId.parse(it) }
        val now = OffsetDateTime.now(clock)
        val expiresAt = target.createdAt.plusDays(7)
        if (target.deleted || target.createdAt.isAfter(now) || !now.isBefore(expiresAt)) {
            metrics.detailsExpired()
            return MessageReadsResponse(emptyList(), null, false, expiresAt, now)
        }
        val fetched = repository.readers(
            chatId,
            userId,
            target.sequence,
            target.createdAt.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate(),
            after,
            limit + 1,
        )
        val page = fetched.take(limit)
        metrics.detailsServed(page.size)
        return MessageReadsResponse(
            readers = page.map { MessageReaderResponse(it.userId.value, it.username, it.readAt) },
            nextUserId = page.lastOrNull()?.takeIf { fetched.size > limit }?.userId?.value,
            detailsAvailable = true,
            detailsExpiresAt = expiresAt,
            serverTime = now,
        )
    }

    private fun publishReadsChanged(chatId: ChatId, rooms: List<String>) {
        outbox.enqueue(
            rooms.map { room ->
                val event = ReadsChangedEventV1.create(eventId = newId(), room = room, chatId = chatId.value)
                OutboxMessage(id = EventId(event.eventId), room = room, payload = mapper.writeValueAsString(event))
            },
        )
    }
}
