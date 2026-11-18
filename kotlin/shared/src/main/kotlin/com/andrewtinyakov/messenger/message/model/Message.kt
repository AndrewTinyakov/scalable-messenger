package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import java.time.OffsetDateTime

data class Message(
    val id: MessageId,
    val chatId: ChatId,
    val sequence: Long,
    val senderId: UserId,
    val body: String,
    val createdAt: OffsetDateTime,
    val messageVersion: Long = 1,
    val editedAt: OffsetDateTime? = null,
    val deletedAt: OffsetDateTime? = null,
    val reply: MessageReply? = null,
    val replyToMessageId: MessageId? = reply?.messageId,
    val forwardedFromUserId: UserId? = null,
) {
    init {
        require(sequence > 0) { "Message sequence must be positive" }
        require(messageVersion > 0) { "Message version must be positive" }
        require(
            if (deletedAt != null) body.isEmpty() else body.isNotBlank() && body.codePointCount(0, body.length) in 1..MAX_BODY_LENGTH,
        ) {
            "Message body must contain 1 to $MAX_BODY_LENGTH characters and cannot be blank"
        }
    }

    companion object {
        const val MAX_BODY_LENGTH = 4000
        const val PREVIEW_LENGTH = 160
        const val MAX_LOOKUP_IDS = 100
    }
}

fun Message.asReply(): MessageReply = MessageReply(
    messageId = id,
    senderId = senderId,
    body = body.substring(0, body.offsetByCodePoints(0, minOf(Message.PREVIEW_LENGTH, body.codePointCount(0, body.length)))),
    deleted = deletedAt != null,
    version = messageVersion,
)
