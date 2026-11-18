package com.andrewtinyakov.messenger.chat.messaging

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.ChatPreferencesChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MemberRemovedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MembershipChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class ChatOutbox(
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    fun chatCreatedMessages(chatId: ChatId, members: List<UserId>): List<OutboxMessage> =
        members.map { userId ->
            ChatCreatedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(userId),
                chatId = chatId.value,
                requestId = null,
            ).toOutboxMessage(mapper)
        }

    fun enqueueMembersAdded(chatId: ChatId, members: List<UserId>) {
        val membershipChanged = MembershipChangedEventV1.create(
            eventId = newId(),
            room = RoomAddress.group(chatId),
            chatId = chatId.value,
        )
        outboxRepository.enqueue(chatCreatedMessages(chatId, members) + membershipChanged.toOutboxMessage(mapper))
    }

    fun enqueueMemberRemoved(chatId: ChatId, memberId: UserId) {
        outboxRepository.enqueue(
            listOf(RoomAddress.user(memberId), RoomAddress.group(chatId)).map { room ->
                MemberRemovedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chatId.value,
                    memberId = memberId.value,
                ).toOutboxMessage(mapper)
            },
        )
    }

    fun enqueuePreferencesChanged(userId: UserId, chatIds: List<ChatId>) {
        outboxRepository.enqueue(
            chatIds.map { chatId ->
                ChatPreferencesChangedEventV1.create(eventId = newId(), room = RoomAddress.user(userId), chatId = chatId.value)
                    .toOutboxMessage(mapper)
            },
        )
    }
}
