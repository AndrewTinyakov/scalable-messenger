package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.directory.ChatDirectoryRepository
import com.andrewtinyakov.messenger.message.messaging.MessageOutbox
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.pin.PinScope
import com.andrewtinyakov.messenger.message.model.pin.PinnedMessage
import com.andrewtinyakov.messenger.message.repository.MessagePinRepository
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.PinnedMessagePageResponse
import com.andrewtinyakov.messenger.message.web.payload.PinnedMessageResponse
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate

@Service
class MessagePinService(
    private val messagePinRepository: MessagePinRepository,
    private val messageRepository: MessageRepository,
    private val chatRepository: ChatRepository,
    private val chatDirectoryRepository: ChatDirectoryRepository,
    private val messageOutbox: MessageOutbox,
    private val tx: TransactionTemplate,
) {
    fun list(chatId: ChatId, userId: UserId, beforeSequence: Long?, limit: Int): PinnedMessagePageResponse =
        tx.execute {
            if (!chatRepository.isMember(chatId, userId)) notFound()
            val fetched = messagePinRepository.page(chatId, userId, beforeSequence, limit + 1)
            val pinnedIds = messagePinRepository.visibleIds(chatId, userId)
            val page = fetched.take(limit)
            val loaded = messageRepository.findMessagesByIds(chatId, userId, page.map { it.messageId }).associateBy { it.id }
            PinnedMessagePageResponse(
                pins = page.mapNotNull { pin -> loaded[pin.messageId]?.let { PinnedMessageResponse(it.toResponse(), pin.scope) } },
                totalCount = pinnedIds.size,
                pinnedMessageIds = pinnedIds.map { it.value },
                nextBeforeSequence = page.lastOrNull()?.takeIf { fetched.size > limit }?.sequence?.toString(),
            )
        }

    fun pin(chatId: ChatId, userId: UserId, messageId: MessageId, scope: PinScope) = tx.executeWithoutResult {
        val (chat, message) = target(chatId, userId, messageId)
        if (scope == PinScope.SELF && chat.kind != ChatKind.DIRECT) {
            invalidInput("scope", "Messages can be pinned only for everyone in groups")
        }
        val viewer = userId.takeIf { scope == PinScope.SELF }
        messagePinRepository.lock(chatId)
        if (messagePinRepository.exists(chatId, message.sequence, viewer)) return@executeWithoutResult
        if (messagePinRepository.count(chatId, viewer) >= PinnedMessage.MAX_PER_SCOPE) {
            conflict(ApiErrorCode.PIN_LIMIT, "A chat can have up to ${PinnedMessage.MAX_PER_SCOPE} pinned messages")
        }
        if (messagePinRepository.pin(chatId, message.sequence, viewer)) announce(chat, userId, viewer)
    }

    fun unpin(chatId: ChatId, userId: UserId, messageId: MessageId) = tx.executeWithoutResult {
        val (chat, message) = target(chatId, userId, messageId)
        messagePinRepository.lock(chatId)
        notifyRemoved(chat, userId, messagePinRepository.unpin(chatId, message.sequence, userId))
    }

    fun unpinAll(chatId: ChatId, userId: UserId) = tx.executeWithoutResult {
        val chat = chatDirectoryRepository.findById(chatId)?.takeIf { chatRepository.isMember(chatId, userId) } ?: notFound()
        messagePinRepository.lock(chatId)
        notifyRemoved(chat, userId, messagePinRepository.unpinAll(chatId, userId))
    }

    private fun notifyRemoved(chat: Chat, userId: UserId, removed: Set<PinScope>) {
        if (PinScope.EVERYONE in removed) announce(chat, userId, personalViewer = null)
        if (PinScope.SELF in removed) announce(chat, userId, personalViewer = userId)
    }

    private fun announce(chat: Chat, userId: UserId, personalViewer: UserId?) {
        if (personalViewer != null) {
            val memberSeq = chatRepository.allocateMemberSequence(chat.id, personalViewer) ?: notFound()
            messageOutbox.enqueuePinsChanged(chat, memberSeq, personalViewer)
            return
        }
        val seq = chatRepository.allocateEventSequence(chat.id, userId) ?: notFound()
        messagePinRepository.recordSharedChange(chat.id, seq)
        messageOutbox.enqueuePinsChanged(chat, seq, personalViewer = null)
    }

    private fun target(chatId: ChatId, userId: UserId, messageId: MessageId): Pair<Chat, Message> {
        val chat = chatDirectoryRepository.findById(chatId) ?: notFound()
        val message = messageRepository.findMessage(chatId, userId, messageId)?.takeIf { it.deletedAt == null } ?: notFound()
        return chat to message
    }
}
