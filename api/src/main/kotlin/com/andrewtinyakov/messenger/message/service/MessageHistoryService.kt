package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.MessageHistoryResponse
import com.andrewtinyakov.messenger.message.web.payload.SendStatusEntry
import com.andrewtinyakov.messenger.message.web.payload.SendStatusResponse
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesResponse
import com.andrewtinyakov.messenger.message.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.requireId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import org.springframework.stereotype.Service

@Service
class MessageHistoryService(
    private val repository: MessageRepository,
    private val membership: ChatMembershipService,
) {
    fun messages(chatId: String, userId: String, afterSeq: String?, beforeSeq: String?, limit: Int): MessageHistoryResponse {
        membership.requireMember(chatId, userId)
        if (limit !in 1..100) badRequest(ApiErrorCode.INVALID_LIMIT, "limit must be 1 to 100")
        if (afterSeq != null && beforeSeq != null) {
            badRequest(ApiErrorCode.INVALID_SEQUENCE, "Use either afterSeq or beforeSeq")
        }
        if (afterSeq != null) {
            val after = afterSeq.toLongOrNull()?.takeIf { it >= 0 }
                ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "afterSeq must be a nonnegative decimal integer")
            val fetched = repository.findMessagesAfter(chatId, after, limit + 1)
            val messages = fetched.take(limit).map { it.toResponse() }
            return MessageHistoryResponse(messages, messages.lastOrNull()?.sequence ?: afterSeq, fetched.size > limit)
        }
        val before = beforeSeq?.let {
            it.toLongOrNull()?.takeIf { sequence -> sequence > 0 }
                ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "beforeSeq must be a positive decimal integer")
        }
        val fetched = repository.findMessagesBefore(chatId, before, limit + 1)
        val messages = fetched.take(limit).asReversed().map { it.toResponse() }
        return MessageHistoryResponse(messages, messages.firstOrNull()?.sequence ?: beforeSeq ?: "0", fetched.size > limit)
    }

    fun status(userId: String, requestId: String): SendStatusResponse {
        requireId(requestId)
        val result = repository.findSendResult(userId, requestId) ?: return SendStatusResponse("unknown")
        return result.toStatusResponse()
    }

    fun statuses(userId: String, requestIds: List<String>): SendStatusesResponse {
        if (requestIds.size !in 1..100 || requestIds.size != requestIds.toSet().size) {
            badRequest(ApiErrorCode.INVALID_ID, "Provide 1 to 100 distinct request IDs")
        }
        requestIds.forEach(::requireId)
        val found = repository.findSendResults(userId, requestIds).associateBy { it.requestId }
        return SendStatusesResponse(
            requestIds.map { requestId ->
                SendStatusEntry(requestId, found[requestId]?.toStatusResponse() ?: SendStatusResponse("unknown"))
            },
        )
    }

    private fun SendResult.toStatusResponse(): SendStatusResponse =
        SendStatusResponse(
            status = status.value,
            chatId = chatId,
            messageId = messageId,
            sequence = sequence?.toString(),
            reason = reason,
        )
}
