package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.message.change.MessageChangeRepository
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.MessageAroundResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangeResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangesResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageHistoryResponse
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.message.web.payload.SendStatusEntry
import com.andrewtinyakov.messenger.message.web.payload.SendStatusResponse
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesResponse
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Service
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.time.Duration

@Service
class MessageHistoryService(
    private val repository: MessageRepository,
    private val chatMembershipService: ChatMembershipService,
    private val metrics: MeterRegistry,
    private val changes: MessageChangeRepository,
    tx: TransactionTemplate,
) {
    private val snapshot = TransactionTemplate(requireNotNull(tx.transactionManager)).apply {
        isolationLevel = TransactionDefinition.ISOLATION_REPEATABLE_READ
        isReadOnly = true
    }

    fun messages(chatId: ChatId, userId: UserId, afterSeq: String?, beforeSeq: String?, limit: Int): MessageHistoryResponse {
        val started = System.nanoTime()
        val direction = if (afterSeq != null) "after" else "before"
        var outcome = "failed"
        try {
            val response = snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
                val revision = changes.cursor(chatId, userId)?.revision ?: notFound()
                historyPage(chatId, userId, afterSeq, beforeSeq, limit).copy(mutationRevision = revision.toString())
            }
            outcome = "success"
            metrics.counter("messenger.history.messages", "direction", direction).increment(response.messages.size.toDouble())
            metrics.counter("messenger.history.body.bytes", "direction", direction)
                .increment(response.messages.sumOf { it.body.toByteArray(Charsets.UTF_8).size }.toDouble())
            return response
        } finally {
            Timer.builder("messenger.history.page").tags("direction", direction, "outcome", outcome)
                .publishPercentileHistogram().minimumExpectedValue(Duration.ofMillis(1)).maximumExpectedValue(Duration.ofMinutes(2))
                .register(metrics).record(Duration.ofNanos(System.nanoTime() - started))
        }
    }

    fun around(chatId: ChatId, userId: UserId, messageId: MessageId, limit: Int): MessageAroundResponse =
        observeHistory("around") {
            snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
                val revision = changes.cursor(chatId, userId)?.revision ?: notFound()
                if (limit !in 1..100) badRequest(ApiErrorCode.INVALID_LIMIT, "limit must be 1 to 100")
                val anchor = repository.findMessage(chatId, userId, messageId) ?: notFound()
                val older = repository.findMessagesBefore(chatId, userId, anchor.sequence, limit)
                val newer = repository.findMessagesAfter(chatId, userId, anchor.sequence, limit)
                val newerCount = minOf(newer.size, limit - 1 - minOf(older.size, (limit - 1) / 2))
                val olderCount = minOf(older.size, limit - 1 - newerCount)
                val rows = older.take(olderCount).asReversed() + anchor + newer.take(newerCount)
                metrics.counter("messenger.history.messages", "direction", "around").increment(rows.size.toDouble())
                MessageAroundResponse(
                    anchor.id.value,
                    rows.map { it.toResponse() },
                    older.size > olderCount,
                    newer.size > newerCount,
                    revision.toString(),
                )
            }
        }

    fun changes(chatId: ChatId, userId: UserId, afterRevision: String, limit: Int): MessageChangesResponse =
        observeHistory("changes") {
            snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
                val cursor = changes.cursor(chatId, userId) ?: notFound()
                if (limit !in 1..100) badRequest(ApiErrorCode.INVALID_LIMIT, "limit must be 1 to 100")
                val after = parseSequence(afterRevision)
                    ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "afterRevision must be a nonnegative decimal integer")
                if (after < cursor.floor || after > cursor.revision) {
                    metrics.counter("messenger.message.changes.resets").increment()
                    return@observedExecute MessageChangesResponse(emptyList(), cursor.revision.toString(), cursor.revision.toString(), true)
                }
                val page = changes.changes(chatId, after, cursor.revision, limit)
                val messages = repository.findMessagesByIds(chatId, userId, page.map { it.messageId }.distinct()).associateBy { it.id }
                MessageChangesResponse(
                    changes = page.map { MessageChangeResponse(it.revision.toString(), checkNotNull(messages[it.messageId]).toResponse()) },
                    lastRevision = cursor.revision.toString(),
                    nextRevision = (page.lastOrNull()?.revision ?: after).toString(),
                    resetRequired = false,
                )
            }
        }

    private fun <T> observeHistory(direction: String, action: () -> T): T {
        val started = System.nanoTime()
        var outcome = "failed"
        try {
            val response = action()
            outcome = "success"
            return response
        } finally {
            Timer.builder("messenger.history.page").tags("direction", direction, "outcome", outcome)
                .publishPercentileHistogram().minimumExpectedValue(Duration.ofMillis(1)).maximumExpectedValue(Duration.ofMinutes(2))
                .register(metrics).record(Duration.ofNanos(System.nanoTime() - started))
        }
    }

    private fun historyPage(chatId: ChatId, userId: UserId, afterSeq: String?, beforeSeq: String?, limit: Int): MessageHistoryResponse {
        if (limit !in 1..100) invalidHistoryRequest(chatId, userId, ApiErrorCode.INVALID_LIMIT, "limit must be 1 to 100")
        if (afterSeq != null && beforeSeq != null) {
            invalidHistoryRequest(chatId, userId, ApiErrorCode.INVALID_SEQUENCE, "Use either afterSeq or beforeSeq")
        }
        if (afterSeq != null) {
            val after = parseSequence(afterSeq)
                ?: invalidHistoryRequest(chatId, userId, ApiErrorCode.INVALID_SEQUENCE, "afterSeq must be a nonnegative decimal integer")
            val fetched = repository.findMessagesAfter(chatId = chatId, userId = userId, afterSequence = after, limit = limit + 1)
            if (fetched.isEmpty()) chatMembershipService.requireMember(chatId = chatId, userId = userId)
            val messages = fetched.take(limit).map { it.toResponse() }
            return MessageHistoryResponse(
                messages = messages,
                nextSequence = messages.lastOrNull()?.sequence ?: afterSeq,
                hasMore = fetched.size > limit,
            )
        }
        val before = beforeSeq?.let {
            parseSequence(it)?.takeIf { sequence -> sequence > 0 }
                ?: invalidHistoryRequest(chatId, userId, ApiErrorCode.INVALID_SEQUENCE, "beforeSeq must be a positive decimal integer")
        }
        val fetched = repository.findMessagesBefore(chatId = chatId, userId = userId, beforeSequence = before, limit = limit + 1)
        if (fetched.isEmpty()) chatMembershipService.requireMember(chatId = chatId, userId = userId)
        val messages = fetched.take(limit).asReversed().map { it.toResponse() }
        return MessageHistoryResponse(
            messages = messages,
            nextSequence = messages.firstOrNull()?.sequence ?: beforeSeq ?: "0",
            hasMore = fetched.size > limit,
        )
    }

    private fun invalidHistoryRequest(chatId: ChatId, userId: UserId, code: ApiErrorCode, message: String): Nothing {
        chatMembershipService.requireMember(chatId = chatId, userId = userId)
        badRequest(code, message)
    }

    fun status(userId: UserId, requestId: RequestId): SendStatusResponse {
        val result =
            repository.findSendResult(senderId = userId, requestId = requestId)
                ?: return SendStatusResponse(status = SendLookupStatus.UNKNOWN)
        return result.toStatusResponse()
    }

    private fun parseSequence(value: String): Long? =
        value.takeIf { Regex("0|[1-9][0-9]{0,18}").matches(it) }?.toLongOrNull()

    fun statuses(userId: UserId, requestIds: List<RequestId>): SendStatusesResponse {
        if (requestIds.size !in 1..100 || requestIds.size != requestIds.toSet().size) {
            badRequest(ApiErrorCode.INVALID_ID, "Provide 1 to 100 distinct request IDs")
        }
        val found = repository.findSendResults(senderId = userId, requestIds = requestIds).associateBy { it.requestId }
        return SendStatusesResponse(
            results = requestIds.map { requestId ->
                SendStatusEntry(
                    requestId = requestId.value,
                    result =
                        found[requestId]?.toStatusResponse() ?: SendStatusResponse(status = SendLookupStatus.UNKNOWN),
                )
            },
        )
    }

    private fun SendResult.toStatusResponse(): SendStatusResponse =
        SendStatusResponse(
            status = when (status) {
                SendResultStatus.SAVED -> SendLookupStatus.SAVED
                SendResultStatus.REJECTED -> SendLookupStatus.REJECTED
            },
            chatId = chatId?.value,
            messageId = messageId?.value,
            sequence = sequence?.toString(),
            reason = reason,
        )
}
