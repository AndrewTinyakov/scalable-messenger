package com.andrewtinyakov.messenger.chat.grpc.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId

data class SidebarChatAuthorization(
    val chatId: ChatId,
    val peerId: UserId?,
    val group: Boolean,
)
