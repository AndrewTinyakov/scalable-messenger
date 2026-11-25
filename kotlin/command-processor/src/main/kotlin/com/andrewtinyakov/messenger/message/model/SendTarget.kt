package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.orderedDirectPair

sealed interface SendTarget {
    data class ExistingChat(
        val id: ChatId,
    ) : SendTarget

    data class DirectPair(
        val first: UserId,
        val second: UserId,
    ) : SendTarget

    companion object {
        internal fun from(request: SendRequest): SendTarget =
            request.chatId?.let(::ExistingChat)
                ?: orderedDirectPair(request.senderId, checkNotNull(request.recipientId)).let { (first, second) ->
                    DirectPair(first, second)
                }
    }
}
