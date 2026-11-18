package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecute
import com.andrewtinyakov.messenger.message.model.AnchorNeighbours
import com.andrewtinyakov.messenger.message.model.AnchorWindow
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.change.MessageChange
import com.andrewtinyakov.messenger.message.model.change.MessageChangeKind
import com.andrewtinyakov.messenger.message.model.change.MutationCursor
import com.andrewtinyakov.messenger.message.model.visibility.VisibilitySnapshot
import com.andrewtinyakov.messenger.message.monitoring.HistoryDirection
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import com.andrewtinyakov.messenger.message.repository.MessageChangeRepository
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.repository.MessageVisibilityRepository
import com.andrewtinyakov.messenger.message.web.payload.MessageAroundResponse
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
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.stereotype.Service
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import com.andrewtinyakov.messenger.message.web.payload.MessageChangeKind as MessageChangeKindResponse

@Service
class MessageHistoryService(
    private val messageRepository: MessageRepository,
    private val metrics: MessageMetrics,
    private val messageChangeRepository: MessageChangeRepository,
    private val messageVisibilityRepository: MessageVisibilityRepository,
    private val visibleHistoryService: VisibleHistoryService,
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
                    invalidInput("afterSeq", "afterSeq exceeds saved history")
                }
                val page = visibleHistoryService.page(
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
            requireAnchorReference(messageId, anchorSequence)
            val requested = findRequestedAnchor(chatId, userId, messageId, anchorSequence)
            val anchorAt = requested?.sequence ?: anchorSequence ?: state.snapshotSequence
            val neighbours = readNeighbours(chatId, userId, state, anchorAt)
            val anchor = requested
                ?: neighbours.closestTo(anchorAt)
                ?: return@observedExecute emptyAround(state, neighbours)
            val window = readWindow(chatId, userId, state, anchor, limit)
            trimWindow(state, anchor, window, limit)
        }
    }

    fun resolve(chatId: ChatId, userId: UserId, ids: List<MessageId>): MessageResolveResponse = snapshot.observedExecute(
        DatabaseTransaction.MESSAGE_HISTORY,
    ) {
        val state = state(chatId, userId)
        if (ids.size !in 1..Message.MAX_LOOKUP_IDS ||
            ids.distinct().size != ids.size
        ) {
            invalidInput("messageIds", "Provide 1 to ${Message.MAX_LOOKUP_IDS} distinct message IDs")
        }
        state.toResolveResponse(messages = messageRepository.findMessagesByIds(chatId, userId, ids))
    }

    fun visibility(chatId: ChatId, userId: UserId): MessageVisibilityResponse = state(chatId, userId).toVisibilityResponse()

    fun changes(chatId: ChatId, userId: UserId, after: Long, limit: Int): MessageChangesResponse = metrics.timeChanges {
        snapshot.observedExecute(DatabaseTransaction.MESSAGE_HISTORY) {
            val state = state(chatId, userId)
            val cursor = messageChangeRepository.cursor(chatId, userId) ?: notFound()
            requirePageLimit(limit)
            if (after < cursor.floor || after > cursor.revision) return@observedExecute resetChanges(state, cursor)
            val page = messageChangeRepository.page(chatId, after, cursor.revision, limit)
            val current = findCurrentMessages(chatId, userId, page)
            state.toChangesResponse(
                changes = page.map { change -> change.toChangeResponse(current[change.messageId]) },
                lastRevision = cursor.revision,
                nextRevision = page.lastOrNull()?.revision ?: after,
                resetRequired = false,
            )
        }
    }

    private fun requireAnchorReference(messageId: MessageId?, anchorSequence: Long?) {
        if (messageId == null && anchorSequence == null) {
            invalidInput(null, "Provide a messageId or anchorSequence")
        }
    }

    private fun findRequestedAnchor(
        chatId: ChatId,
        userId: UserId,
        messageId: MessageId?,
        anchorSequence: Long?,
    ): Message? {
        val requested = messageId?.let { messageRepository.findMessage(chatId, userId, it) }
        if (messageId != null && requested == null && anchorSequence == null) notFound()
        return requested
    }

    private fun readNeighbours(chatId: ChatId, userId: UserId, state: VisibilitySnapshot, anchorAt: Long): AnchorNeighbours =
        AnchorNeighbours(
            before = visibleHistoryService.page(
                chatId = chatId,
                userId = userId,
                state = state,
                cursor = minOf(anchorAt, state.snapshotSequence) + 1,
                ascending = false,
                limit = 1,
            ),
            after = visibleHistoryService.page(
                chatId = chatId,
                userId = userId,
                state = state,
                cursor = minOf(maxOf(anchorAt - 1, 0), state.snapshotSequence),
                ascending = true,
                limit = 1,
            ),
        )

    private fun emptyAround(state: VisibilitySnapshot, neighbours: AnchorNeighbours): MessageAroundResponse = state.toAroundResponse(
        anchorMessageId = null,
        messages = emptyList(),
        hasOlder = neighbours.before.hasMore,
        hasNewer = neighbours.after.hasMore,
        coverageAfterSequence = neighbours.before.after,
        coverageThroughSequence = neighbours.after.through,
    )

    private fun readWindow(
        chatId: ChatId,
        userId: UserId,
        state: VisibilitySnapshot,
        anchor: Message,
        limit: Int,
    ): AnchorWindow = AnchorWindow(
        older = visibleHistoryService.page(
            chatId = chatId,
            userId = userId,
            state = state,
            cursor = anchor.sequence,
            ascending = false,
            limit = limit,
        ),
        newer = visibleHistoryService.page(
            chatId = chatId,
            userId = userId,
            state = state,
            cursor = anchor.sequence,
            ascending = true,
            limit = limit,
        ),
    )

    private fun trimWindow(state: VisibilitySnapshot, anchor: Message, window: AnchorWindow, limit: Int): MessageAroundResponse {
        val older = window.older
        val newer = window.newer
        val newerCount = minOf(newer.messages.size, limit - 1 - minOf(older.messages.size, (limit - 1) / 2))
        val olderCount = minOf(older.messages.size, limit - 1 - newerCount)
        val rows = older.messages.takeLast(olderCount) + anchor + newer.messages.take(newerCount)
        val after = if (olderCount == older.messages.size) older.after else rows.first().sequence - 1
        val through = if (newerCount == newer.messages.size) newer.through else rows.last().sequence
        return state.toAroundResponse(
            anchorMessageId = anchor.id,
            messages = rows,
            hasOlder = older.hasMore || older.messages.size > olderCount,
            hasNewer = newer.hasMore || newer.messages.size > newerCount,
            coverageAfterSequence = after,
            coverageThroughSequence = through,
        )
    }

    private fun resetChanges(state: VisibilitySnapshot, cursor: MutationCursor): MessageChangesResponse {
        metrics.changesReset()
        return state.toChangesResponse(
            changes = emptyList(),
            lastRevision = cursor.revision,
            nextRevision = cursor.revision,
            resetRequired = true,
        )
    }

    private fun findCurrentMessages(chatId: ChatId, userId: UserId, page: List<MessageChange>): Map<MessageId, Message> =
        messageRepository.findMessagesByIds(chatId, userId, page.mapNotNull { it.messageId }.distinct()).associateBy { it.id }

    private fun MessageChange.toChangeResponse(current: Message?): MessageChangeResponse {
        val resolvedKind = if (kind == MessageChangeKind.UPSERT && current == null) MessageChangeKind.REMOVED else kind
        return MessageChangeResponse(
            revision = revision.toString(),
            kind = MessageChangeKindResponse.valueOf(resolvedKind.name),
            message = if (resolvedKind == MessageChangeKind.UPSERT) current?.toResponse() else null,
            messageId = messageId?.value,
            sequence = sequence?.toString(),
            clearedThroughSequence = clearedThroughSequence?.toString(),
        )
    }

    private fun state(chatId: ChatId, userId: UserId): VisibilitySnapshot =
        messageVisibilityRepository.snapshot(chatId, userId) ?: notFound()
}
