package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.chat.messaging.ChatOutbox
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.chat.model.MemberChange
import com.andrewtinyakov.messenger.chat.model.MuteEnd
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.preferences.ChatPreferencesRepository
import com.andrewtinyakov.messenger.chat.web.payload.ChatPreferencesResponse
import com.andrewtinyakov.messenger.chat.web.payload.PinnedChatsResponse
import com.andrewtinyakov.messenger.chat.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

@Service
class ChatPreferencesService(
    private val chatPreferencesRepository: ChatPreferencesRepository,
    private val chatRepository: ChatRepository,
    private val userRepository: UserRepository,
    private val chatOutbox: ChatOutbox,
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
            invalidInput(
                "durationSeconds",
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
        tx.execute {
            if (!update()) notFound()
            val memberSeq = chatRepository.allocateMemberSequence(chatId, userId, MemberChange.OTHER) ?: notFound()
            chatOutbox.enqueueMemberPreferencesChanged(userId, chatId, memberSeq)
            checkNotNull(chatPreferencesRepository.find(chatId, userId)).toResponse(chatId.value)
        }

    private fun changePins(userId: UserId, change: (List<ChatId>) -> List<ChatId>): PinnedChatsResponse =
        tx.execute {
            chatPreferencesRepository.lockPins(userId)
            val current = chatPreferencesRepository.pinnedChatIds(userId)
            val next = change(current)
            if (next != current) {
                chatPreferencesRepository.replacePinnedOrder(userId, next)
                val moved = (current + next).distinct().filter { current.indexOf(it) != next.indexOf(it) }
                chatOutbox.enqueuePinOrderChanged(userId, moved, userRepository.allocateEventSequences(userId, moved.size))
            }
            PinnedChatsResponse(next.map(ChatId::value))
        }
}
