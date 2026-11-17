package com.andrewtinyakov.messenger.deletion.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatKind

data class DeletionChat(
    val kind: ChatKind,
    val ownerId: UserId?,
    val lastSequence: Long,
    val mutationRevision: Long,
    val visibilityRevision: Long,
    val purgedRows: Long,
    val deleted: Boolean,
)
