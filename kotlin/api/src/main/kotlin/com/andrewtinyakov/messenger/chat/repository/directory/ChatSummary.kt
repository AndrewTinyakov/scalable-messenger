package com.andrewtinyakov.messenger.chat.repository.directory

import com.andrewtinyakov.messenger.chat.model.ChatLastMessage

internal data class ChatSummary(
    val unreadCount: Int,
    val unreadCountCapped: Boolean,
    val lastMessage: ChatLastMessage?,
)
