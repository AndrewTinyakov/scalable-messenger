package com.andrewtinyakov.messenger.ws.model

import com.andrewtinyakov.messenger.chat.model.ChatId

data class GroupAuthorization(
    val authorizedChatIds: Set<ChatId>,
) {
    companion object {
        const val MAX_CHATS_PER_REQUEST = 10
    }
}
