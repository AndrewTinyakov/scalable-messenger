package com.andrewtinyakov.messenger.chat.deletion.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatKind

data class DeletionChat(
    val kind: ChatKind,
    val owner: UserId?,
    val high: Long,
    val revision: Long,
    val visibility: Long,
    val purgedRows: Long,
    val deleted: Boolean,
)
