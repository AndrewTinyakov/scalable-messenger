package com.andrewtinyakov.messenger.ws.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId

data class SidebarChatAuthorization(
    val chatId: ChatId,
    val peerId: UserId?,
    val group: Boolean,
) {
    companion object {
        const val MAX_CHATS = 100
    }
}
