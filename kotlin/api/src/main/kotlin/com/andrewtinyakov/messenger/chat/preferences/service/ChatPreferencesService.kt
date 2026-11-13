package com.andrewtinyakov.messenger.chat.preferences.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.chat.preferences.model.MuteEnd
import com.andrewtinyakov.messenger.chat.preferences.repository.ChatPreferencesRepository
import com.andrewtinyakov.messenger.chat.preferences.web.payload.ChatPreferencesResponse
import com.andrewtinyakov.messenger.chat.preferences.web.payload.PinnedChatsResponse
import com.andrewtinyakov.messenger.chat.preferences.web.payload.toResponse
import com.andrewtinyakov.messenger.generated.messaging.event.ChatPreferencesChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.outbox.model.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
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

@Service
class ChatPreferencesService(
    private val chatPreferencesRepository: ChatPreferencesRepository,
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
    private val clock: Clock,
) {
    fun pin(chatId: ChatId, userId: UserId): PinnedChatsResponse = changePins(userId) { current ->
        when {
            chatId in current -> {
                current
            }

            !chatPreferencesRepository.isVisibleMember(chatId, userId) -> {
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
        if (durationSeconds != null && durationSeconds !in MuteEnd.MIN_DURATION_SECONDS..MuteEnd.MAX_DURATION_SECONDS) {
            badRequest(
                ApiErrorCode.INVALID_REQUEST,
                "durationSeconds must be ${MuteEnd.MIN_DURATION_SECONDS} to ${MuteEnd.MAX_DURATION_SECONDS}",
            )
        }
        val end = durationSeconds?.let { MuteEnd.At(OffsetDateTime.now(clock).plusSeconds(it)) } ?: MuteEnd.Forever
        return change(chatId, userId) { chatPreferencesRepository.mute(chatId, userId, end) }
    }

    fun unmute(chatId: ChatId, userId: UserId): ChatPreferencesResponse = change(chatId, userId) {
        chatPreferencesRepository.mute(chatId, userId, null)
    }

    fun markUnread(chatId: ChatId, userId: UserId, unread: Boolean): ChatPreferencesResponse = change(chatId, userId) {
        chatPreferencesRepository.markUnread(chatId, userId, if (unread) OffsetDateTime.now(clock) else null)
    }

    private fun change(chatId: ChatId, userId: UserId, update: () -> Boolean): ChatPreferencesResponse =
        tx.observedExecute(DatabaseTransaction.CHAT_PREFERENCES) {
            if (!update()) notFound()
            notify(userId, listOf(chatId))
            checkNotNull(chatPreferencesRepository.find(chatId, userId)).toResponse(chatId.value)
        }

    private fun changePins(userId: UserId, change: (List<ChatId>) -> List<ChatId>): PinnedChatsResponse =
        tx.observedExecute(DatabaseTransaction.CHAT_PREFERENCES) {
            chatPreferencesRepository.lockPins(userId)
            val current = chatPreferencesRepository.pinnedChatIds(userId)
            val next = change(current)
            if (next != current) {
                chatPreferencesRepository.replacePinnedOrder(userId, next)
                notify(userId, (current + next).distinct().filter { current.indexOf(it) != next.indexOf(it) })
            }
            PinnedChatsResponse(next.map(ChatId::value))
        }

    private fun notify(userId: UserId, chatIds: List<ChatId>) {
        outboxRepository.enqueue(
            chatIds.map { chatId ->
                ChatPreferencesChangedEventV1.create(eventId = newId(), room = RoomAddress.user(userId), chatId = chatId.value)
                    .toOutboxMessage(mapper)
            },
        )
    }
}
