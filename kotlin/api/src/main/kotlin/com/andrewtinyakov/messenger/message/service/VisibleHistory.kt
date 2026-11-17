package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.VisibilitySnapshot
import com.andrewtinyakov.messenger.message.monitoring.HistoryDirection
import com.andrewtinyakov.messenger.message.monitoring.MessageMetrics
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.repository.VisibilityRepository
import org.springframework.stereotype.Component

private const val SPAN_BUDGET = 16

data class VisiblePage(
    val messages: List<Message>,
    val next: Long,
    val hasMore: Boolean,
    val after: Long,
    val through: Long,
)

@Component
class VisibleHistory(
    private val messageRepository: MessageRepository,
    private val visibilityRepository: VisibilityRepository,
    private val metrics: MessageMetrics,
) {
    fun page(chatId: ChatId, userId: UserId, state: VisibilitySnapshot, cursor: Long?, ascending: Boolean, limit: Int): VisiblePage =
        if (ascending) {
            after(chatId, userId, state, cursor ?: 0, limit)
        } else {
            before(
                chatId,
                userId,
                state,
                cursor ?: state.snapshotSequence + 1,
                limit,
            )
        }

    private fun after(chatId: ChatId, userId: UserId, state: VisibilitySnapshot, after: Long, limit: Int): VisiblePage {
        val snapshotSequence = state.snapshotSequence
        val start = minOf(after, snapshotSequence)
        var cursor = maxOf(start, state.floor)
        val rows = mutableListOf<Message>()
        repeat(SPAN_BUDGET) {
            if (cursor >= snapshotSequence || rows.size >= limit) return@repeat
            val hidden = visibilityRepository.containing(chatId, userId, cursor + 1)
            if (hidden != null) {
                cursor = minOf(hidden.through, snapshotSequence)
            } else {
                val end = minOf(visibilityRepository.next(chatId, userId, cursor)?.after ?: snapshotSequence, snapshotSequence)
                val remaining = limit - rows.size
                val fetched = messageRepository.findMessagesInSpan(chatId, userId, cursor, end, true, remaining + 1)
                rows.addAll(fetched.take(remaining))
                cursor = if (fetched.size > remaining) rows.last().sequence else end
            }
        }
        if (cursor < snapshotSequence && rows.size < limit) metrics.spanBudgetExhausted(HistoryDirection.AFTER)
        return VisiblePage(rows, cursor, cursor < snapshotSequence, start, cursor)
    }

    private fun before(chatId: ChatId, userId: UserId, state: VisibilitySnapshot, before: Long, limit: Int): VisiblePage {
        val through = minOf(before - 1, state.snapshotSequence)
        var cursor = through
        val rows = mutableListOf<Message>()
        repeat(SPAN_BUDGET) {
            if (cursor <= state.floor || rows.size >= limit) return@repeat
            val hidden = visibilityRepository.containing(chatId, userId, cursor)
            if (hidden != null) {
                cursor = maxOf(hidden.after, state.floor)
            } else {
                val end = maxOf(visibilityRepository.previous(chatId, userId, cursor + 1)?.through ?: state.floor, state.floor)
                val remaining = limit - rows.size
                val fetched = messageRepository.findMessagesInSpan(chatId, userId, end, cursor, false, remaining + 1)
                rows.addAll(fetched.take(remaining))
                cursor = if (fetched.size > remaining) rows.last().sequence - 1 else end
            }
        }
        if (cursor > state.floor && rows.size < limit) metrics.spanBudgetExhausted(HistoryDirection.BEFORE)
        return VisiblePage(rows.asReversed(), cursor + 1, cursor > state.floor, cursor, through)
    }
}
