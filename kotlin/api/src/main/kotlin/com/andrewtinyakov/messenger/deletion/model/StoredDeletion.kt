package com.andrewtinyakov.messenger.deletion.model

import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.RequestId

data class StoredDeletion(
    val requestId: RequestId,
    val chatId: ChatId,
    val fingerprint: String,
    val scope: DeletionScope,
    val target: DeletionTarget,
    val clearedThroughSequence: Long,
    val seq: Long,
    val visibilitySeq: Long,
    val state: DeletionState,
    val deletedRows: Long,
)
