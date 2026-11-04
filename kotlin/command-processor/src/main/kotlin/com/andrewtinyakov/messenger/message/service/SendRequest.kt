package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId

private const val MAX_BODY_CODE_POINTS = 4000

internal data class SendRequest(
    val chatId: ChatId?,
    val recipientId: UserId?,
    val requestId: RequestId,
    val senderId: UserId,
    val body: String,
    val replyToMessageId: MessageId?,
) {
    val key: Pair<UserId, RequestId> get() = senderId to requestId

    val fingerprint: String by lazy(LazyThreadSafetyMode.NONE) {
        val target = chatId?.value ?: "direct:${recipientId?.value}"
        val reply = replyToMessageId
        if (reply == null) {
            sha256("$target\u0000${senderId.value}\u0000$body")
        } else {
            sha256("reply-v1\u0000$target\u0000${senderId.value}\u0000${reply.value}\u0000$body")
        }
    }

    val bodyRejection: SendRejectionReason?
        get() = when {
            body.isBlank() -> SendRejectionReason.EMPTY_BODY
            body.codePointCount(0, body.length) > MAX_BODY_CODE_POINTS -> SendRejectionReason.BODY_TOO_LONG
            else -> null
        }
}

internal fun SendMessageCommandV1.toSendRequest(): SendRequest {
    require(version == 1) { "Unsupported command version" }
    require((chatId == null) != (recipientId == null)) { "Exactly one chat target is required" }
    return SendRequest(
        chatId = chatId?.let(::ChatId),
        recipientId = recipientId?.let(::UserId),
        requestId = RequestId(requestId),
        senderId = UserId(senderId),
        body = body,
        replyToMessageId = replyToMessageId?.let(::MessageId),
    )
}
