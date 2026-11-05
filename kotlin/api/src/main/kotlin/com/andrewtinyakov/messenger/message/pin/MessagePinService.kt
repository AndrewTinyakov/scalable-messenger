package com.andrewtinyakov.messenger.message.pin

import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.PinsChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.conflict
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.parseSequence
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper

const val MAX_PINS_PER_SCOPE = 200

@Service
class MessagePinService(
    private val pins: MessagePinRepository,
    private val messages: MessageRepository,
    private val chats: ChatRepository,
    private val outbox: OutboxRepository,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
) {
    fun list(chatId: ChatId, userId: UserId, beforeSequence: String?, limit: Int): PinnedMessagePageResponse {
        requirePageLimit(limit)
        val before = beforeSequence?.let {
            parseSequence(it) ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "beforeSequence must be a nonnegative decimal integer")
        }
        return tx.observedExecute(DatabaseTransaction.MESSAGE_PIN) {
            if (!chats.isMember(chatId, userId)) notFound()
            val fetched = pins.page(chatId, userId, before, limit + 1)
            val page = fetched.take(limit)
            val loaded = messages.findMessagesByIds(chatId, userId, page.map { it.messageId }).associateBy { it.id }
            PinnedMessagePageResponse(
                pins = page.mapNotNull { pin -> loaded[pin.messageId]?.let { PinnedMessageResponse(it.toResponse(), pin.scope) } },
                totalCount = pins.visibleCount(chatId, userId),
                nextBeforeSequence = page.lastOrNull()?.takeIf { fetched.size > limit }?.sequence?.toString(),
            )
        }
    }

    fun pin(chatId: ChatId, userId: UserId, messageId: MessageId, scope: PinScope) = tx.observedExecuteWithoutResult(
        DatabaseTransaction.MESSAGE_PIN,
    ) {
        val (chat, message) = target(chatId, userId, messageId)
        if (scope == PinScope.SELF && chat.kind != ChatKind.DIRECT) {
            badRequest(ApiErrorCode.INVALID_REQUEST, "Messages can be pinned only for everyone in groups")
        }
        val viewer = userId.takeIf { scope == PinScope.SELF }
        pins.lock(chatId)
        if (pins.count(chatId, viewer) >= MAX_PINS_PER_SCOPE) {
            conflict(ApiErrorCode.PIN_LIMIT, "A chat can have up to $MAX_PINS_PER_SCOPE pinned messages")
        }
        if (pins.pin(chatId, message.sequence, viewer)) notify(chat, viewer)
    }

    fun unpin(chatId: ChatId, userId: UserId, messageId: MessageId) = tx.observedExecuteWithoutResult(DatabaseTransaction.MESSAGE_PIN) {
        val (chat, message) = target(chatId, userId, messageId)
        pins.lock(chatId)
        if (pins.unpin(chatId, message.sequence, userId) > 0) notify(chat, null)
    }

    fun unpinAll(chatId: ChatId, userId: UserId) = tx.observedExecuteWithoutResult(DatabaseTransaction.MESSAGE_PIN) {
        val chat = chats.findById(chatId)?.takeIf { chats.isMember(chatId, userId) } ?: notFound()
        pins.lock(chatId)
        if (pins.unpinAll(chatId, userId) > 0) notify(chat, null)
    }

    private fun target(chatId: ChatId, userId: UserId, messageId: MessageId): Pair<Chat, Message> {
        val chat = chats.findById(chatId) ?: notFound()
        val message = messages.findMessage(chatId, userId, messageId)?.takeIf { it.deletedAt == null } ?: notFound()
        return chat to message
    }

    private fun notify(chat: Chat, personalViewer: UserId?) {
        val rooms = when {
            personalViewer != null -> listOf(RoomAddress.user(personalViewer))
            chat.kind == ChatKind.GROUP -> listOf(RoomAddress.group(chat.id))
            else -> chats.findMemberIds(chat.id).map(RoomAddress::user)
        }
        outbox.enqueue(
            rooms.map { room ->
                val event = PinsChangedEventV1.create(eventId = newId(), room = room, chatId = chat.id.value)
                OutboxMessage(EventId(event.eventId), event.room, mapper.writeValueAsString(event))
            },
        )
    }
}
