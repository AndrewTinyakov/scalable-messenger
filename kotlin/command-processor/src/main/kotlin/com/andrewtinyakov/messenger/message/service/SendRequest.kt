package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.crypto.sha256

private const val MAX_BODY_CODE_POINTS = 4000

internal data class SendRequest(
    val chatId: ChatId?,
    val recipientId: UserId?,
    val requestId: RequestId,
    val senderId: UserId,
    val body: String,
    val replyToMessageId: MessageId?,
    val forwardSource: ForwardSource? = null,
) {
    val key: Pair<UserId, RequestId> get() = senderId to requestId

    val fingerprint: String by lazy(LazyThreadSafetyMode.NONE) {
        val target = chatId?.value ?: "direct:${recipientId?.value}"
        val reply = replyToMessageId
        val forward = forwardSource
        if (forward != null) {
            sha256("forward-v1\u0000$target\u0000${senderId.value}\u0000${forward.chatId.value}\u0000${forward.messageId.value}\u0000$body")
        } else if (reply == null) {
            sha256("$target\u0000${senderId.value}\u0000$body")
        } else {
            sha256("reply-v1\u0000$target\u0000${senderId.value}\u0000${reply.value}\u0000$body")
        }
    }

    val draftReferenceRejection: SendRejectionReason?
        get() = when {
            recipientId == null -> null
            replyToMessageId != null -> SendRejectionReason.INVALID_REPLY_TARGET
            forwardSource != null -> SendRejectionReason.INVALID_FORWARD_SOURCE
            else -> null
        }

    val bodyRejection: SendRejectionReason?
        get() = when {
            body.isBlank() -> SendRejectionReason.EMPTY_BODY
            body.codePointCount(0, body.length) > MAX_BODY_CODE_POINTS -> SendRejectionReason.BODY_TOO_LONG
            else -> null
        }
}

internal data class ForwardSource(
    val chatId: ChatId,
    val messageId: MessageId,
)

internal fun SendMessageCommandV1.toSendRequest(): SendRequest {
    require(version == 1) { "Unsupported command version" }
    require((chatId == null) != (recipientId == null)) { "Exactly one chat target is required" }
    require((forwardFromChatId == null) == (forwardFromMessageId == null)) { "A forward needs both its source chat and message" }
    return SendRequest(
        chatId = chatId?.let(::ChatId),
        recipientId = recipientId?.let(::UserId),
        requestId = RequestId(requestId),
        senderId = UserId(senderId),
        body = body,
        replyToMessageId = replyToMessageId?.let(::MessageId),
        forwardSource = forwardFromChatId?.let { ForwardSource(ChatId(it), MessageId(forwardFromMessageId!!)) },
    )
}
