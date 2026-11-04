package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.message.change.MessageChangeRepository
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.visibility.VisibilityRepository
import com.andrewtinyakov.messenger.message.visibility.VisibilitySnapshot
import com.andrewtinyakov.messenger.message.web.payload.MessageAroundResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangeKind
import com.andrewtinyakov.messenger.message.web.payload.MessageChangeResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangesResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageHistoryResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageResolveResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageVisibilityResponse
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
    private val metrics: MeterRegistry,
    private val changes: MessageChangeRepository,
    private val visibility: VisibilityRepository,
    private val pages: VisibleHistory,
    tx: TransactionTemplate,
) {
    private val snapshot = TransactionTemplate(requireNotNull(tx.transactionManager)).apply {
        isolationLevel = TransactionDefinition.ISOLATION_REPEATABLE_READ
        isReadOnly = true
    }

    fun messages(chatId: ChatId, userId: UserId, afterSeq: String?, beforeSeq: String?, limit: Int): MessageHistoryResponse =
        measured(if (afterSeq != null) "after" else "before") {
            snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
                val state = state(chatId, userId)
                requireLimit(limit)
                if (afterSeq != null && beforeSeq != null) badRequest(ApiErrorCode.INVALID_SEQUENCE, "Use either afterSeq or beforeSeq")
                val cursor = (afterSeq ?: beforeSeq)?.let { sequence(it, beforeSeq != null) }
                if (afterSeq != null && cursor != null &&
                    cursor > state.snapshotSequence
                ) {
                    badRequest(ApiErrorCode.INVALID_SEQUENCE, "afterSeq exceeds saved history")
                }
                val page = pages.page(chatId, userId, state, cursor, afterSeq != null, limit)
                metrics.counter(
                    "messenger.history.messages",
                    "direction",
                    if (afterSeq !=
                        null
                    ) {
                        "after"
                    } else {
                        "before"
                    },
                ).increment(page.messages.size.toDouble())
                MessageHistoryResponse(
                    page.messages.map { it.toResponse() },
                    page.next.toString(),
                    page.hasMore,
                    state.mutationRevision.toString(),
                    state.snapshotSequence.toString(),
                    state.visibilityRevision.toString(),
                    state.clearedThroughSequence.toString(),
                    state.globalClearedThroughSequence.toString(),
                    page.after.toString(),
                    page.through.toString(),
                )
            }
        }

    fun around(chatId: ChatId, userId: UserId, messageId: MessageId, limit: Int): MessageAroundResponse = around(
        chatId,
        userId,
        messageId,
        null,
        limit,
    )

    fun around(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId?,
        anchorSequence: String?,
        limit: Int,
    ): MessageAroundResponse = measured(
        "around",
    ) {
        snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
            val state = state(chatId, userId)
            requireLimit(limit)
            if (messageId == null &&
                anchorSequence == null
            ) {
                badRequest(ApiErrorCode.INVALID_REQUEST, "Provide a messageId or anchorSequence")
            }
            val requested = messageId?.let { repository.findMessage(chatId, userId, it) }
            if (messageId != null && requested == null && anchorSequence == null) notFound()
            val anchorAt = requested?.sequence ?: anchorSequence?.let { sequence(it, true) } ?: state.snapshotSequence
            val beforeAnchor = pages.page(chatId, userId, state, minOf(anchorAt, state.snapshotSequence) + 1, false, 1)
            val afterAnchor = pages.page(chatId, userId, state, minOf(maxOf(anchorAt - 1, 0), state.snapshotSequence), true, 1)
            val anchor =
                requested
                    ?: listOfNotNull(beforeAnchor.messages.lastOrNull(), afterAnchor.messages.firstOrNull()).minByOrNull {
                        kotlin.math.abs(it.sequence - anchorAt)
                    }
            if (anchor ==
                null
            ) {
                return@observedExecute MessageAroundResponse(
                    null,
                    emptyList(),
                    beforeAnchor.hasMore,
                    afterAnchor.hasMore,
                    state.mutationRevision.toString(),
                    state.snapshotSequence.toString(),
                    state.visibilityRevision.toString(),
                    state.clearedThroughSequence.toString(),
                    state.globalClearedThroughSequence.toString(),
                    beforeAnchor.after.toString(),
                    afterAnchor.through.toString(),
                )
            }
            val older = pages.page(chatId, userId, state, anchor.sequence, false, limit)
            val newer = pages.page(chatId, userId, state, anchor.sequence, true, limit)
            val newerCount = minOf(newer.messages.size, limit - 1 - minOf(older.messages.size, (limit - 1) / 2))
            val olderCount = minOf(older.messages.size, limit - 1 - newerCount)
            val rows = older.messages.takeLast(olderCount) + anchor + newer.messages.take(newerCount)
            val after = if (olderCount == older.messages.size) older.after else rows.first().sequence - 1
            val through = if (newerCount == newer.messages.size) newer.through else rows.last().sequence
            MessageAroundResponse(
                anchor.id.value,
                rows.map { it.toResponse() },
                older.hasMore || older.messages.size > olderCount,
                newer.hasMore || newer.messages.size > newerCount,
                state.mutationRevision.toString(),
                state.snapshotSequence.toString(),
                state.visibilityRevision.toString(),
                state.clearedThroughSequence.toString(),
                state.globalClearedThroughSequence.toString(),
                after.toString(),
                through.toString(),
            )
        }
    }

    fun resolve(chatId: ChatId, userId: UserId, ids: List<MessageId>): MessageResolveResponse = snapshot.observedExecute(
        DatabaseTransaction.MESSAGE_HISTORY,
    ) {
        val state = state(chatId, userId)
        if (ids.size !in 1..100 ||
            ids.distinct().size != ids.size
        ) {
            badRequest(ApiErrorCode.INVALID_REQUEST, "Provide 1 to 100 distinct message IDs")
        }
        MessageResolveResponse(
            repository.findMessagesByIds(chatId, userId, ids).map { it.toResponse() },
            state.snapshotSequence.toString(),
            state.mutationRevision.toString(),
            state.visibilityRevision.toString(),
            state.clearedThroughSequence.toString(),
            state.globalClearedThroughSequence.toString(),
        )
    }

    fun visibility(chatId: ChatId, userId: UserId): MessageVisibilityResponse = state(chatId, userId).let {
        MessageVisibilityResponse(
            it.snapshotSequence.toString(),
            it.mutationRevision.toString(),
            it.visibilityRevision.toString(),
            it.clearedThroughSequence.toString(),
            it.globalClearedThroughSequence.toString(),
            it.hidden,
        )
    }

    fun changes(chatId: ChatId, userId: UserId, afterRevision: String, limit: Int): MessageChangesResponse = measured("changes") {
        snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
            val state = state(chatId, userId)
            val cursor = changes.cursor(chatId, userId) ?: notFound()
            requireLimit(limit)
            val after = sequence(afterRevision)
            if (after < cursor.floor || after > cursor.revision) {
                metrics.counter("messenger.message.changes.resets").increment()
                return@observedExecute MessageChangesResponse(
                    emptyList(),
                    cursor.revision.toString(),
                    cursor.revision.toString(),
                    true,
                    state.snapshotSequence.toString(),
                    state.visibilityRevision.toString(),
                    state.clearedThroughSequence.toString(),
                    state.globalClearedThroughSequence.toString(),
                )
            }
            val page = changes.changes(chatId, after, cursor.revision, limit)
            val current = repository.findMessagesByIds(chatId, userId, page.mapNotNull { it.messageId }.distinct()).associateBy { it.id }
            MessageChangesResponse(
                page.map { change ->
                    val message = current[change.messageId]
                    val kind = if (change.kind == "UPSERT" &&
                        message == null
                    ) {
                        MessageChangeKind.REMOVED
                    } else {
                        MessageChangeKind.valueOf(change.kind)
                    }
                    MessageChangeResponse(
                        change.revision.toString(),
                        kind,
                        if (kind ==
                            MessageChangeKind.UPSERT
                        ) {
                            message?.toResponse()
                        } else {
                            null
                        },
                        change.messageId?.value,
                        change.sequence?.toString(),
                        change.clearedThroughSequence?.toString(),
                    )
                },
                cursor.revision.toString(),
                (page.lastOrNull()?.revision ?: after).toString(),
                false,
                state.snapshotSequence.toString(),
                state.visibilityRevision.toString(),
                state.clearedThroughSequence.toString(),
                state.globalClearedThroughSequence.toString(),
            )
        }
    }

    private fun state(chatId: ChatId, userId: UserId): VisibilitySnapshot = visibility.snapshot(chatId, userId) ?: notFound()

    private fun requireLimit(limit: Int) {
        if (limit !in 1..100) badRequest(ApiErrorCode.INVALID_LIMIT, "limit must be 1 to 100")
    }

    private fun sequence(value: String, positive: Boolean = false): Long =
        value.takeIf { Regex("0|[1-9][0-9]{0,18}").matches(it) }?.toLongOrNull()
            ?.takeIf { !positive || it > 0 } ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "Invalid decimal sequence")

    private fun <T> measured(direction: String, action: () -> T): T {
        val started = System.nanoTime()
        var outcome = "failed"
        try {
            val result = action()
            outcome = "success"
            return result
        } finally {
            Timer.builder("messenger.history.page").tags("direction", direction, "outcome", outcome).publishPercentileHistogram()
                .minimumExpectedValue(
                    Duration.ofMillis(1),
                ).maximumExpectedValue(Duration.ofMinutes(2)).register(metrics).record(Duration.ofNanos(System.nanoTime() - started))
        }
    }

    fun status(userId: UserId, requestId: RequestId): SendStatusResponse =
        repository.findSendResult(userId, requestId)?.toStatusResponse() ?: SendStatusResponse(SendLookupStatus.UNKNOWN)

    fun statuses(userId: UserId, requestIds: List<RequestId>): SendStatusesResponse {
        if (requestIds.size !in 1..100 ||
            requestIds.size != requestIds.toSet().size
        ) {
            badRequest(ApiErrorCode.INVALID_ID, "Provide 1 to 100 distinct request IDs")
        }
        val found = repository.findSendResults(userId, requestIds).associateBy { it.requestId }
        return SendStatusesResponse(
            requestIds.map {
                SendStatusEntry(
                    it.value,
                    found[it]?.toStatusResponse() ?: SendStatusResponse(SendLookupStatus.UNKNOWN),
                )
            },
        )
    }

    private fun SendResult.toStatusResponse(): SendStatusResponse = SendStatusResponse(
        if (status ==
            SendResultStatus.SAVED
        ) {
            SendLookupStatus.SAVED
        } else {
            SendLookupStatus.REJECTED
        },
        chatId?.value,
        messageId?.value,
        sequence?.toString(),
        reason,
    )
}
