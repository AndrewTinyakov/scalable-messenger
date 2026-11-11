package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.message.change.repository.MessageChangeRepository
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.monitoring.HistoryDirection
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.visibility.model.VisibilitySnapshot
import com.andrewtinyakov.messenger.message.visibility.repository.VisibilityRepository
import com.andrewtinyakov.messenger.message.web.payload.MessageAroundResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangeKind
import com.andrewtinyakov.messenger.message.web.payload.MessageChangeResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangesResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageHistoryResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageResolveResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageVisibilityResponse
import com.andrewtinyakov.messenger.message.web.payload.toAroundResponse
import com.andrewtinyakov.messenger.message.web.payload.toChangesResponse
import com.andrewtinyakov.messenger.message.web.payload.toHistoryResponse
import com.andrewtinyakov.messenger.message.web.payload.toResolveResponse
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.message.web.payload.toVisibilityResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.stereotype.Service
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import kotlin.math.abs

@Service
class MessageHistoryService(
    private val repository: MessageRepository,
    private val metrics: MessageMetrics,
    private val changes: MessageChangeRepository,
    private val visibility: VisibilityRepository,
    private val pages: VisibleHistory,
    tx: TransactionTemplate,
) {
    private val snapshot = TransactionTemplate(requireNotNull(tx.transactionManager)).apply {
        isolationLevel = TransactionDefinition.ISOLATION_REPEATABLE_READ
        isReadOnly = true
    }

    fun messages(chatId: ChatId, userId: UserId, afterSeq: Long?, beforeSeq: Long?, limit: Int): MessageHistoryResponse {
        require(afterSeq == null || beforeSeq == null)
        val direction = if (afterSeq != null) HistoryDirection.AFTER else HistoryDirection.BEFORE
        return metrics.timeMessages(direction) {
            snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
                val state = state(chatId, userId)
                requirePageLimit(limit)
                if (afterSeq != null && afterSeq > state.snapshotSequence) {
                    badRequest(ApiErrorCode.INVALID_SEQUENCE, "afterSeq exceeds saved history")
                }
                val page = pages.page(
                    chatId = chatId,
                    userId = userId,
                    state = state,
                    cursor = afterSeq ?: beforeSeq,
                    ascending = afterSeq != null,
                    limit = limit,
                )
                metrics.messagesServed(direction, page.messages.size)
                state.toHistoryResponse(
                    messages = page.messages,
                    nextSequence = page.next,
                    hasMore = page.hasMore,
                    coverageAfterSequence = page.after,
                    coverageThroughSequence = page.through,
                )
            }
        }
    }

    fun around(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId?,
        anchorSequence: Long?,
        limit: Int,
    ): MessageAroundResponse = metrics.timeAround {
        snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
            val state = state(chatId, userId)
            requirePageLimit(limit)
            if (messageId == null &&
                anchorSequence == null
            ) {
                badRequest(ApiErrorCode.INVALID_REQUEST, "Provide a messageId or anchorSequence")
            }
            val requested = messageId?.let { repository.findMessage(chatId, userId, it) }
            if (messageId != null && requested == null && anchorSequence == null) notFound()
            val anchorAt = requested?.sequence ?: anchorSequence ?: state.snapshotSequence
            val beforeAnchor = pages.page(
                chatId = chatId,
                userId = userId,
                state = state,
                cursor = minOf(anchorAt, state.snapshotSequence) + 1,
                ascending = false,
                limit = 1,
            )
            val afterAnchor = pages.page(
                chatId = chatId,
                userId = userId,
                state = state,
                cursor = minOf(maxOf(anchorAt - 1, 0), state.snapshotSequence),
                ascending = true,
                limit = 1,
            )
            val anchor =
                requested
                    ?: listOfNotNull(beforeAnchor.messages.lastOrNull(), afterAnchor.messages.firstOrNull()).minByOrNull {
                        abs(it.sequence - anchorAt)
                    }
            if (anchor == null) {
                return@observedExecute state.toAroundResponse(
                    anchorMessageId = null,
                    messages = emptyList(),
                    hasOlder = beforeAnchor.hasMore,
                    hasNewer = afterAnchor.hasMore,
                    coverageAfterSequence = beforeAnchor.after,
                    coverageThroughSequence = afterAnchor.through,
                )
            }
            val older = pages.page(
                chatId = chatId,
                userId = userId,
                state = state,
                cursor = anchor.sequence,
                ascending = false,
                limit = limit,
            )
            val newer = pages.page(
                chatId = chatId,
                userId = userId,
                state = state,
                cursor = anchor.sequence,
                ascending = true,
                limit = limit,
            )
            val newerCount = minOf(newer.messages.size, limit - 1 - minOf(older.messages.size, (limit - 1) / 2))
            val olderCount = minOf(older.messages.size, limit - 1 - newerCount)
            val rows = older.messages.takeLast(olderCount) + anchor + newer.messages.take(newerCount)
            val after = if (olderCount == older.messages.size) older.after else rows.first().sequence - 1
            val through = if (newerCount == newer.messages.size) newer.through else rows.last().sequence
            state.toAroundResponse(
                anchorMessageId = anchor.id,
                messages = rows,
                hasOlder = older.hasMore || older.messages.size > olderCount,
                hasNewer = newer.hasMore || newer.messages.size > newerCount,
                coverageAfterSequence = after,
                coverageThroughSequence = through,
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
        state.toResolveResponse(messages = repository.findMessagesByIds(chatId, userId, ids))
    }

    fun visibility(chatId: ChatId, userId: UserId): MessageVisibilityResponse = state(chatId, userId).toVisibilityResponse()

    fun changes(chatId: ChatId, userId: UserId, after: Long, limit: Int): MessageChangesResponse = metrics.timeChanges {
        snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
            val state = state(chatId, userId)
            val cursor = changes.cursor(chatId, userId) ?: notFound()
            requirePageLimit(limit)
            if (after < cursor.floor || after > cursor.revision) {
                metrics.changesReset()
                return@observedExecute state.toChangesResponse(
                    changes = emptyList(),
                    lastRevision = cursor.revision,
                    nextRevision = cursor.revision,
                    resetRequired = true,
                )
            }
            val page = changes.changes(chatId, after, cursor.revision, limit)
            val current = repository.findMessagesByIds(chatId, userId, page.mapNotNull { it.messageId }.distinct()).associateBy { it.id }
            state.toChangesResponse(
                changes = page.map { change ->
                    val message = current[change.messageId]
                    val kind = if (change.kind == "UPSERT" &&
                        message == null
                    ) {
                        MessageChangeKind.REMOVED
                    } else {
                        MessageChangeKind.valueOf(change.kind)
                    }
                    MessageChangeResponse(
                        revision = change.revision.toString(),
                        kind = kind,
                        message = if (kind == MessageChangeKind.UPSERT) {
                            message?.toResponse()
                        } else {
                            null
                        },
                        messageId = change.messageId?.value,
                        sequence = change.sequence?.toString(),
                        clearedThroughSequence = change.clearedThroughSequence?.toString(),
                    )
                },
                lastRevision = cursor.revision,
                nextRevision = page.lastOrNull()?.revision ?: after,
                resetRequired = false,
            )
        }
    }

    private fun state(chatId: ChatId, userId: UserId): VisibilitySnapshot = visibility.snapshot(chatId, userId) ?: notFound()
}
