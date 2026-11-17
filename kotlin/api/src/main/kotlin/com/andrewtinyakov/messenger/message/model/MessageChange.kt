package com.andrewtinyakov.messenger.message.model

data class MessageChange(
    val revision: Long,
    val messageId: MessageId?,
    val kind: MessageChangeKind = MessageChangeKind.UPSERT,
    val sequence: Long? = null,
    val clearedThroughSequence: Long? = null,
)
