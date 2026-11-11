package com.andrewtinyakov.messenger.chat.deletion.model

import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.RequestId

data class StoredDeletion(
    val requestId: RequestId,
    val chatId: ChatId,
    val fingerprint: String,
    val scope: DeletionScope,
    val target: DeletionTarget,
    val clearedThroughSequence: Long,
    val mutationRevision: Long,
    val visibilityRevision: Long,
    val state: DeletionState,
    val deletedRows: Long,
)
