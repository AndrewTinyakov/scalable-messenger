package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason

internal class SendChatContext(
    val chat: Chat?,
    val members: Set<UserId>,
    val replyTargets: Map<Pair<UserId, MessageId>, Message>,
    val forwardSources: Map<Pair<UserId, ForwardSource>, Message>,
) {
    fun rejection(request: SendRequest): SendRejectionReason? = when {
        chat == null -> SendRejectionReason.CHAT_NOT_FOUND
        request.senderId !in members -> SendRejectionReason.NOT_A_MEMBER
        request.forwardSource != null && request.replyToMessageId != null -> SendRejectionReason.INVALID_FORWARD_SOURCE
        request.replyToMessageId != null && replyTarget(request) == null -> SendRejectionReason.INVALID_REPLY_TARGET
        request.forwardSource != null && forwardSource(request) == null -> SendRejectionReason.INVALID_FORWARD_SOURCE
        else -> null
    }

    fun replyTarget(request: SendRequest): MessageReply? =
        request.replyToMessageId?.let { replyTargets[request.senderId to it] }?.asReply()

    fun forwardSource(request: SendRequest): Message? = request.forwardSource?.let { forwardSources[request.senderId to it] }
}
