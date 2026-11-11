package com.andrewtinyakov.messenger.message.pin.model

import com.andrewtinyakov.messenger.message.model.MessageId

data class PinnedMessage(
    val messageId: MessageId,
    val sequence: Long,
    val scope: PinScope,
)
