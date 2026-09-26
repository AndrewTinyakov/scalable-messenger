package com.andrewtinyakov.messenger.conversation

import com.andrewtinyakov.messenger.shared.ApiException
import com.andrewtinyakov.messenger.shared.requireId
import io.swagger.v3.oas.annotations.media.Schema
import org.springframework.stereotype.Service
import java.time.OffsetDateTime

data class MessageView(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val conversationId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val sequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val senderId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val body: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val createdAt: OffsetDateTime,
)

data class HistoryView(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val messages: List<MessageView>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val nextSequence: String,
)

data class SendStatusView(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val status: String,
    val messageId: String? = null,
    val sequence: String? = null,
    val reason: String? = null,
)

@Service
class HistoryService(
    private val repository: HistoryRepository,
    private val conversations: ConversationService,
) {
    fun messages(conversationId: String, userId: String, afterSeq: String, limit: Int): HistoryView {
        conversations.requireMember(conversationId, userId)
        val after = afterSeq.toLongOrNull()?.takeIf { it >= 0 }
            ?: throw ApiException(400, "INVALID_SEQUENCE", "afterSeq must be a nonnegative decimal integer")
        if (limit !in 1..100) throw ApiException(400, "INVALID_LIMIT", "limit must be 1 to 100")
        val messages = repository.findMessagesAfter(conversationId, after, limit).map {
            MessageView(it.id, it.conversationId, it.sequence.toString(), it.senderId, it.body, it.createdAt)
        }
        return HistoryView(messages, messages.lastOrNull()?.sequence ?: afterSeq)
    }

    fun status(conversationId: String, userId: String, requestId: String): SendStatusView {
        requireId(conversationId)
        requireId(requestId)
        val result = repository.findSendResult(conversationId, userId, requestId)
        if (result == null) {
            conversations.requireMember(conversationId, userId)
            return SendStatusView("unknown")
        }
        return SendStatusView(result.status, result.messageId, result.sequence?.toString(), result.reason)
    }
}
