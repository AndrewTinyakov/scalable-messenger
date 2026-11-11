package com.andrewtinyakov.messenger.chat.deletion.model

import com.andrewtinyakov.messenger.chat.deletion.web.payload.DeletionResponse

data class StoredDeletion(
    val chatId: String,
    val fingerprint: String,
    val response: DeletionResponse,
)
