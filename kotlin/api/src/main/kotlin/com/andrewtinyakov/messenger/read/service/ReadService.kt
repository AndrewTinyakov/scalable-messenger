package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.generated.messaging.event.ReadsChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.read.repository.ReadRepository
import com.andrewtinyakov.messenger.read.web.payload.AdvanceReadRequest
import com.andrewtinyakov.messenger.read.web.payload.MessageReaderResponse
import com.andrewtinyakov.messenger.read.web.payload.MessageReadsResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadProgressResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadSummaryResponse
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
import org.springframework.http.HttpStatus
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
    fun advance(chatId: ChatId, userId: UserId, input: AdvanceReadRequest): ReadProgressResponse = measured("advance") {
        tx.observedExecute(DatabaseTransaction.READ_ADVANCE) {
            val lastSequence = repository.requireMember(chatId, userId)
            val sequence = input.throughSequence.takeIf { Regex("0|[1-9][0-9]{0,18}").matches(it) }?.toLongOrNull()
                ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "throughSequence must be a nonnegative decimal integer")
            if (sequence > lastSequence) badRequest(ApiErrorCode.INVALID_SEQUENCE, "throughSequence exceeds saved history")
            val advanced = repository.advance(chatId, userId, sequence)
            metrics.count("requests", if (advanced.advanced) "advanced" else "unchanged")
            if (advanced.advanced) {
                metrics.count("ranges", "inserted", advanced.rangesWritten)
                metrics.count("batches", "ranges")
                val rooms = (repository.notificationRooms(chatId, advanced.progress.readAt!!) + RoomAddress.user(userId)).distinct()
                metrics.count("notifications", if (rooms.isEmpty()) "coalesced" else "emitted")
                outbox.enqueue(
                    rooms.map { room ->
                        val event = ReadsChangedEventV1.create(eventId = newId(), room = room, chatId = chatId.value)
                        OutboxMessage(id = EventId(event.eventId), room = room, payload = mapper.writeValueAsString(event))
                    },
                )
            }
            ReadProgressResponse(advanced.progress.throughSequence.toString(), advanced.progress.readAt, OffsetDateTime.now(clock))
        }
    }

    fun summary(chatId: ChatId, userId: UserId): ReadSummaryResponse = measured("summary") {
        val summary = repository.summary(chatId, userId) ?: notFound()
        ReadSummaryResponse(summary.throughSequence.toString(), summary.maxOtherReadSequence.toString(), OffsetDateTime.now(clock))
    }

    fun readers(chatId: ChatId, userId: UserId, messageId: MessageId, afterUserId: String?, limit: Int): MessageReadsResponse = measured(
        "details",
    ) {
        val target = repository.messageTarget(chatId, userId, messageId) ?: notFound()
        if (limit !in 1..100) badRequest(ApiErrorCode.INVALID_LIMIT, "limit must be 1 to 100")
        val after = afterUserId?.let { UserId(requireId(it)) }
        val now = OffsetDateTime.now(clock)
        val expiresAt = target.createdAt.plusDays(7)
        if (target.deleted || target.createdAt.isAfter(now) || !now.isBefore(expiresAt)) {
            metrics.count("details", "expired")
            return@measured MessageReadsResponse(emptyList(), null, false, expiresAt, now)
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
        metrics.count("details", "rows", page.size)
        MessageReadsResponse(
            readers = page.map { MessageReaderResponse(it.userId.value, it.username, it.readAt) },
            nextUserId = page.lastOrNull()?.takeIf { fetched.size > limit }?.userId?.value,
            detailsAvailable = true,
            detailsExpiresAt = expiresAt,
            serverTime = now,
        )
    }

    private inline fun <T> measured(operation: String, action: () -> T): T {
        val started = System.nanoTime()
        try {
            return action()
        } catch (failure: ApiException) {
            metrics.count("requests", if (failure.status == HttpStatus.NOT_FOUND) "unauthorized" else "invalid")
            throw failure
        } catch (failure: Exception) {
            metrics.count("requests", "failed")
            throw failure
        } finally {
            metrics.duration(operation, started)
        }
    }
}
