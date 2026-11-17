package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.auth.model.UserId

data class SidebarChatAuthorization(
    val chatId: ChatId,
    val peerId: UserId?,
    val group: Boolean,
) {
    companion object {
        const val MAX_CHATS = 100
    }
}
