package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.web.payload.toResponse
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.GroupMembershipRepository
import com.andrewtinyakov.messenger.chat.web.payload.GroupMemberPageResponse
import com.andrewtinyakov.messenger.generated.messaging.event.MemberRemovedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper

@Service
class ChatMembershipService(
    private val chatRepository: ChatRepository,
    private val groupMembershipRepository: GroupMembershipRepository,
    private val tx: TransactionTemplate,
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    fun listMembers(chatId: ChatId, viewerId: UserId, afterUserId: UserId?, limit: Int): GroupMemberPageResponse {
        requirePageLimit(limit)
        val fetched = groupMembershipRepository.findGroupMemberPage(chatId, viewerId, afterUserId, limit + 1) ?: notFound()
        val page = fetched.take(limit)
        return GroupMemberPageResponse(
            members = page.map(UserSummary::toResponse),
            nextCursor = page.lastOrNull()?.takeIf { fetched.size > limit }?.id?.value,
        )
    }

    fun removeMember(chatId: ChatId, userId: UserId, memberId: UserId) {
        tx.observedExecuteWithoutResult(DatabaseTransaction.CHAT_REMOVE_MEMBER) {
            val owner = chatRepository.findByIdForUpdate(chatId = chatId)?.takeIf { it.kind == ChatKind.GROUP }?.ownerId ?: notFound()
            if (owner != userId) forbidden("Only the group owner can remove members")
            if (memberId == owner) badRequest(ApiErrorCode.INVALID_MEMBER, "The group owner cannot be removed")
            if (!groupMembershipRepository.deleteMemberAndDecrementCount(chatId = chatId, userId = memberId)) {
                notFound(ApiErrorCode.MEMBER_NOT_FOUND, "Member not found")
            }
            val events = listOf(RoomAddress.user(memberId), RoomAddress.group(chatId)).map { room ->
                MemberRemovedEventV1.create(
                    eventId = newId(),
                    room = room,
                    chatId = chatId.value,
                    memberId = memberId.value,
                ).toOutboxMessage(mapper)
            }
            outboxRepository.enqueue(events)
        }
    }
}
