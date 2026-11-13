package com.andrewtinyakov.messenger.chat.deletion.model

import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId

data class DeletionCommand(
    val requestId: RequestId,
    val scope: DeletionScope,
    val target: DeletionTarget,
    val messageIds: List<MessageId>? = null,
) {
    init {
        if (target == DeletionTarget.MESSAGES) {
            val ids = requireNotNull(messageIds)
            require(ids.size in 1..MAX_MESSAGE_IDS && ids.distinct().size == ids.size)
        } else {
            require(messageIds == null)
        }
    }

    companion object {
        const val MAX_MESSAGE_IDS = 100
    }
}
