package com.andrewtinyakov.messenger.chat.preferences

import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.generated.messaging.event.ChatPreferencesChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.OffsetDateTime

private const val MIN_MUTE_SECONDS = 60L
private const val MAX_MUTE_SECONDS = 366L * 24 * 60 * 60

@Service
class ChatPreferencesService(
    private val repository: ChatPreferencesRepository,
    private val outbox: OutboxRepository,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
    private val clock: Clock,
) {
    fun pin(chatId: ChatId, userId: UserId): PinnedChatsResponse = changePins(userId) { current ->
        when {
            chatId in current -> {
                current
            }

            !repository.isVisibleMember(chatId, userId) -> {
                notFound()
            }

            current.size >= ChatPreferences.MAX_PINNED_CHATS -> {
                conflict(ApiErrorCode.PIN_LIMIT, "You can pin up to ${ChatPreferences.MAX_PINNED_CHATS} chats")
            }

            else -> {
                listOf(chatId) + current
            }
        }
    }

    fun unpin(chatId: ChatId, userId: UserId): PinnedChatsResponse = changePins(userId) { current -> current - chatId }

    fun reorder(userId: UserId, requested: List<ChatId>): PinnedChatsResponse = changePins(userId) { current ->
        if (requested.distinct() != requested || requested.toSet() != current.toSet()) {
            conflict(ApiErrorCode.PIN_ORDER_CHANGED, "Pinned chats changed. Refresh and try again")
        }
        requested
    }

    fun mute(chatId: ChatId, userId: UserId, durationSeconds: Long?): ChatPreferencesResponse {
        if (durationSeconds != null && durationSeconds !in MIN_MUTE_SECONDS..MAX_MUTE_SECONDS) {
            badRequest(ApiErrorCode.INVALID_REQUEST, "durationSeconds must be $MIN_MUTE_SECONDS to $MAX_MUTE_SECONDS")
        }
        val end = durationSeconds?.let { MuteEnd.At(OffsetDateTime.now(clock).plusSeconds(it)) } ?: MuteEnd.Forever
        return change(chatId, userId) { repository.mute(chatId, userId, end) }
    }

    fun unmute(chatId: ChatId, userId: UserId): ChatPreferencesResponse = change(chatId, userId) { repository.mute(chatId, userId, null) }

    fun markUnread(chatId: ChatId, userId: UserId, unread: Boolean): ChatPreferencesResponse = change(chatId, userId) {
        repository.markUnread(chatId, userId, if (unread) OffsetDateTime.now(clock) else null)
    }

    private fun change(chatId: ChatId, userId: UserId, update: () -> Boolean): ChatPreferencesResponse =
        tx.observedExecute(DatabaseTransaction.CHAT_PREFERENCES) {
            if (!update()) notFound()
            notify(userId, listOf(chatId))
            checkNotNull(repository.find(chatId, userId)).toResponse(chatId.value)
        }

    private fun changePins(userId: UserId, change: (List<ChatId>) -> List<ChatId>): PinnedChatsResponse =
        tx.observedExecute(DatabaseTransaction.CHAT_PREFERENCES) {
            repository.lockPins(userId)
            val current = repository.pinnedChatIds(userId)
            val next = change(current)
            if (next != current) {
                repository.replacePinnedOrder(userId, next)
                notify(userId, (current + next).distinct().filter { current.indexOf(it) != next.indexOf(it) })
            }
            PinnedChatsResponse(next.map(ChatId::value))
        }

    private fun notify(userId: UserId, chatIds: List<ChatId>) {
        outbox.enqueue(
            chatIds.map { chatId ->
                val event = ChatPreferencesChangedEventV1.create(eventId = newId(), room = RoomAddress.user(userId), chatId = chatId.value)
                OutboxMessage(EventId(event.eventId), event.room, mapper.writeValueAsString(event))
            },
        )
    }
}
