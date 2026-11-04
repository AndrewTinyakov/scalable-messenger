package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.messaging.event.MemberRemovedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxWriter
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.id.requireId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper

@Service
class ChatMembershipService(
    private val repository: ChatRepository,
    private val tx: TransactionTemplate,
    private val outbox: OutboxWriter,
    private val mapper: ObjectMapper,
) {
    fun removeMember(chatId: String, actorId: String, memberId: String) {
        requireId(chatId)
        requireId(memberId)
        tx.executeWithoutResult {
            val owner = repository.findGroupOwnerForUpdate(chatId) ?: notFound()
            if (owner != actorId) {
                throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, "Only the group owner can remove members")
            }
            if (memberId == owner) badRequest(ApiErrorCode.INVALID_MEMBER, "The group owner cannot be removed")
            if (!repository.deleteMember(chatId, memberId)) {
                throw ApiException(HttpStatus.NOT_FOUND, ApiErrorCode.MEMBER_NOT_FOUND, "Member not found")
            }
            val event = MemberRemovedEventV1(
                type = "member_removed",
                version = 1,
                eventId = newId(),
                room = "user:$memberId",
                chatId = chatId,
            )
            outbox.enqueue(event.eventId, event.room, mapper.writeValueAsString(event))
        }
    }

    fun requireMember(chatId: String, userId: String) {
        requireId(chatId)
        if (!repository.isMember(chatId, userId)) notFound()
    }
}
