package com.andrewtinyakov.messenger.deletion.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.message.model.MessageId

data class DeletionMessage(
    val id: MessageId,
    val sequence: Long,
    val senderId: UserId,
    val messageVersion: Long,
) {
    companion object {
        const val MAX_PER_REQUEST = 100
    }
}
