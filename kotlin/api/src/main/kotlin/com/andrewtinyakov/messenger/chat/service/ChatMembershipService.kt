package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.web.payload.toResponse
import com.andrewtinyakov.messenger.chat.messaging.ChatOutbox
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.membership.GroupMembershipRepository
import com.andrewtinyakov.messenger.chat.web.payload.GroupMemberPageResponse
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate

@Service
class ChatMembershipService(
    private val chatRepository: ChatRepository,
    private val groupMembershipRepository: GroupMembershipRepository,
    private val tx: TransactionTemplate,
    private val chatOutbox: ChatOutbox,
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
            if (memberId == owner) invalidInput("userId", "The group owner cannot be removed")
            if (!groupMembershipRepository.deleteMemberAndDecrementCount(chatId = chatId, userId = memberId)) {
                notFound("Member not found")
            }
            chatOutbox.enqueueMemberRemoved(chatId = chatId, memberId = memberId)
        }
    }
}
