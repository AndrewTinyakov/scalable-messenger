package com.andrewtinyakov.messenger.chat.repository.state

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatState

interface ChatStateRepository {
    fun find(chatId: ChatId, userId: UserId): ChatState?
}
