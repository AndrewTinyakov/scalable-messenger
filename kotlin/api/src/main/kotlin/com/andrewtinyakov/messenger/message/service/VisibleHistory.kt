package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.visibility.VisibilityRepository
import com.andrewtinyakov.messenger.message.visibility.VisibilitySnapshot
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.stereotype.Component

data class VisiblePage(
    val messages: List<Message>,
    val next: Long,
    val hasMore: Boolean,
    val after: Long,
    val through: Long,
)

@Component
class VisibleHistory(
    private val messages: MessageRepository,
    private val visibility: VisibilityRepository,
    private val metrics: MeterRegistry,
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
        val high = state.snapshotSequence
        val start = minOf(after, high)
        var cursor = maxOf(start, state.floor)
        val rows = mutableListOf<Message>()
        repeat(16) {
            if (cursor >= high || rows.size >= limit) return@repeat
            val hidden = visibility.containing(chatId, userId, cursor + 1)
            if (hidden != null) {
                cursor = minOf(hidden.through, high)
            } else {
                val end = minOf(visibility.next(chatId, userId, cursor)?.after ?: high, high)
                val remaining = limit - rows.size
                val fetched = messages.findMessagesInSpan(chatId, userId, cursor, end, true, remaining + 1)
                rows.addAll(fetched.take(remaining))
                cursor = if (fetched.size > remaining) rows.last().sequence else end
            }
        }
        if (cursor < high && rows.size < limit) metrics.counter("messenger.history.span.budget.exhausted", "direction", "after").increment()
        return VisiblePage(rows, cursor, cursor < high, start, cursor)
    }

    private fun before(chatId: ChatId, userId: UserId, state: VisibilitySnapshot, before: Long, limit: Int): VisiblePage {
        val high = minOf(before - 1, state.snapshotSequence)
        var cursor = high
        val rows = mutableListOf<Message>()
        repeat(16) {
            if (cursor <= state.floor || rows.size >= limit) return@repeat
            val hidden = visibility.containing(chatId, userId, cursor)
            if (hidden != null) {
                cursor = maxOf(hidden.after, state.floor)
            } else {
                val end = maxOf(visibility.previous(chatId, userId, cursor + 1)?.through ?: state.floor, state.floor)
                val remaining = limit - rows.size
                val fetched = messages.findMessagesInSpan(chatId, userId, end, cursor, false, remaining + 1)
                rows.addAll(fetched.take(remaining))
                cursor = if (fetched.size > remaining) rows.last().sequence - 1 else end
            }
        }
        if (cursor > state.floor &&
            rows.size < limit
        ) {
            metrics.counter("messenger.history.span.budget.exhausted", "direction", "before").increment()
        }
        return VisiblePage(rows.asReversed(), cursor + 1, cursor > state.floor, cursor, high)
    }
}
