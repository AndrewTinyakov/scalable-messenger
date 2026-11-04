package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId

sealed interface SendTarget {
    data class ExistingChat(
        val id: ChatId,
    ) : SendTarget

    data class DirectPair(
        val first: UserId,
        val second: UserId,
    ) : SendTarget

    companion object {
        fun from(command: SendMessageCommandV1): SendTarget {
            require(command.version == 1) { "Unsupported command version" }
            require((command.chatId == null) != (command.recipientId == null)) { "Exactly one chat target is required" }
            RequestId(command.requestId)
            val sender = UserId(command.senderId)
            return command.chatId?.let { ExistingChat(ChatId(it)) } ?: run {
                val recipient = UserId(command.recipientId!!)
                if (sender.value <= recipient.value) DirectPair(sender, recipient) else DirectPair(recipient, sender)
            }
        }
    }
}
