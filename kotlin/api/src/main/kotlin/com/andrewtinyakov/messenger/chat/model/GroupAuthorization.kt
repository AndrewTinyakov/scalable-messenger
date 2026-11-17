package com.andrewtinyakov.messenger.chat.model

data class GroupAuthorization(
    val authorizedChatIds: Set<ChatId>,
) {
    companion object {
        const val MAX_CHATS_PER_REQUEST = 10
    }
}
