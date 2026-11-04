package com.andrewtinyakov.messenger.chat.model

data class Chat(
    val id: String,
    val kind: ChatKind,
    val name: String?,
    val lastSequence: Long,
)
