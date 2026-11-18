package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.ReadsChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.read.config.ReadProperties
import com.andrewtinyakov.messenger.read.model.CommittedAdvance
import com.andrewtinyakov.messenger.read.model.MessageReadTarget
import com.andrewtinyakov.messenger.read.monitoring.ReadMetrics
import com.andrewtinyakov.messenger.read.repository.ReadRepository
import com.andrewtinyakov.messenger.read.web.payload.MessageReaderResponse
import com.andrewtinyakov.messenger.read.web.payload.MessageReadsResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadProgressResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadSummaryResponse
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime
import java.time.ZoneOffset

@Service
class ReadService(
    private val readRepository: ReadRepository,
    private val outboxRepository: OutboxRepository,
    private val properties: ReadProperties,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
    private val clock: Clock,
    private val metrics: ReadMetrics,
) {
    fun advance(chatId: ChatId, userId: UserId, throughSequence: Long): ReadProgressResponse {
        val committed = tx.observedExecute(DatabaseTransaction.READ_ADVANCE) {
            val lastSequence = readRepository.requireMember(chatId, userId)
            if (throughSequence > lastSequence) badRequest(ApiErrorCode.INVALID_SEQUENCE, "throughSequence exceeds saved history")
            val advance = readRepository.advance(chatId, userId, throughSequence)
            if (!advance.advanced) return@observedExecute CommittedAdvance(advance, notificationCoalesced = false)
            val sharedRooms = readRepository.notificationRooms(chatId, advance.progress.readAt!!)
            if (sharedRooms.isNotEmpty()) readRepository.completeNotification(chatId, userId)
            publishReadsChanged(chatId, (sharedRooms + RoomAddress.user(userId)).distinct())
            CommittedAdvance(advance, notificationCoalesced = sharedRooms.isEmpty())
        }
        val advance = committed.advance
        if (advance.advanced) metrics.advanced(advance.rangesWritten, committed.notificationCoalesced) else metrics.unchanged()
        return ReadProgressResponse(
            throughSequence = advance.progress.throughSequence.toString(),
            readAt = advance.progress.readAt,
            serverTime = OffsetDateTime.now(clock),
        )
    }

    fun publishPendingNotifications() {
        tx.observedExecute(DatabaseTransaction.READ_ADVANCE) {
            readRepository.pendingNotifications(OffsetDateTime.now(clock), properties.notificationBatchSize).forEach { (chatId, rooms) ->
                publishReadsChanged(chatId, rooms)
            }
        }
    }

    fun summary(chatId: ChatId, userId: UserId): ReadSummaryResponse {
        val summary = readRepository.summary(chatId, userId) ?: notFound()
        return ReadSummaryResponse(
            throughSequence = summary.throughSequence.toString(),
            maxOtherReadSequence = summary.maxOtherReadSequence.toString(),
            serverTime = OffsetDateTime.now(clock),
        )
    }

    fun readers(chatId: ChatId, userId: UserId, messageId: MessageId, afterUserId: UserId?, limit: Int): MessageReadsResponse {
        val target = readRepository.messageTarget(chatId, userId, messageId) ?: notFound()
        requirePageLimit(limit)
        val now = OffsetDateTime.now(clock)
        val expiresAt = target.createdAt.plusDays(MessageReadTarget.DETAILS_RETENTION_DAYS)
        if (target.deleted || target.createdAt.isAfter(now) || !now.isBefore(expiresAt)) {
            metrics.detailsExpired()
            return MessageReadsResponse(
                readers = emptyList(),
                nextUserId = null,
                detailsAvailable = false,
                detailsExpiresAt = expiresAt,
                serverTime = now,
            )
        }
        val fetched = readRepository.readers(
            chatId = chatId,
            userId = userId,
            sequence = target.sequence,
            creationDay = target.createdAt.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate(),
            afterUserId = afterUserId,
            limit = limit + 1,
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
        outboxRepository.enqueue(
            rooms.map { room ->
                ReadsChangedEventV1.create(eventId = newId(), room = room, chatId = chatId.value).toOutboxMessage(mapper)
            },
        )
    }
}
