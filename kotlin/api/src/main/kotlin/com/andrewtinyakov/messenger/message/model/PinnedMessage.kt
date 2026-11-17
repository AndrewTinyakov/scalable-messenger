package com.andrewtinyakov.messenger.message.model

data class PinnedMessage(
    val messageId: MessageId,
    val sequence: Long,
    val scope: PinScope,
) {
    companion object {
        const val MAX_PER_SCOPE = 200
        const val MAX_VISIBLE = MAX_PER_SCOPE * 2
    }
}
