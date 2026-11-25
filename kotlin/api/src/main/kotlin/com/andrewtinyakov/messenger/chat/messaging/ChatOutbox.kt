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
    fun chatCreatedMessages(chatId: ChatId, userSeqs: Map<UserId, Long>): List<OutboxMessage> =
        userSeqs.map { (userId, userSeq) ->
            ChatCreatedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(userId),
                chatId = chatId.value,
                requestId = null,
                userSeq = userSeq.toString(),
            ).toOutboxMessage(mapper)
        }

    fun enqueueMembersAdded(chatId: ChatId, userSeqs: Map<UserId, Long>, seq: Long) {
        val membershipChanged = MembershipChangedEventV1.create(
            eventId = newId(),
            room = RoomAddress.group(chatId),
            chatId = chatId.value,
            seq = seq.toString(),
        )
        outboxRepository.enqueue(chatCreatedMessages(chatId, userSeqs) + membershipChanged.toOutboxMessage(mapper))
    }

    fun enqueueMemberRemoved(chatId: ChatId, memberId: UserId, seq: Long, userSeq: Long) {
        outboxRepository.enqueue(
            listOf(
                removal(RoomAddress.user(memberId), chatId, memberId, userSeq = userSeq.toString()),
                removal(RoomAddress.group(chatId), chatId, memberId, seq = seq.toString()),
            ),
        )
    }

    fun enqueueMemberPreferencesChanged(userId: UserId, chatId: ChatId, memberSeq: Long) {
        outboxRepository.enqueue(
            ChatPreferencesChangedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(userId),
                chatId = chatId.value,
                memberSeq = memberSeq.toString(),
            ).toOutboxMessage(mapper),
        )
    }

    fun enqueuePinOrderChanged(userId: UserId, chatIds: List<ChatId>, firstUserSeq: Long) {
        outboxRepository.enqueue(
            chatIds.mapIndexed { index, chatId ->
                ChatPreferencesChangedEventV1.create(
                    eventId = newId(),
                    room = RoomAddress.user(userId),
                    chatId = chatId.value,
                    userSeq = (firstUserSeq + index).toString(),
                ).toOutboxMessage(mapper)
            },
        )
    }

    private fun removal(room: String, chatId: ChatId, memberId: UserId, seq: String? = null, userSeq: String? = null) =
        MemberRemovedEventV1.create(
            eventId = newId(),
            room = room,
            chatId = chatId.value,
            memberId = memberId.value,
            seq = seq,
            userSeq = userSeq,
        ).toOutboxMessage(mapper)
}
