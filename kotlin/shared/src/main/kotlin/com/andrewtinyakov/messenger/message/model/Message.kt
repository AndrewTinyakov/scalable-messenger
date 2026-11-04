package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
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
) {
    init {
        require(sequence > 0) { "Message sequence must be positive" }
        require(messageVersion > 0) { "Message version must be positive" }
        require(if (deletedAt != null) body.isEmpty() else body.isNotBlank() && body.codePointCount(0, body.length) in 1..4000) {
            "Message body must contain 1 to 4000 characters and cannot be blank"
        }
    }
}

data class MessageReply(
    val messageId: MessageId,
    val senderId: UserId,
    val body: String,
    val deleted: Boolean,
    val version: Long,
)

fun Message.asReply(): MessageReply = MessageReply(
    messageId = id,
    senderId = senderId,
    body = body.substring(0, body.offsetByCodePoints(0, minOf(160, body.codePointCount(0, body.length)))),
    deleted = deletedAt != null,
    version = messageVersion,
)
