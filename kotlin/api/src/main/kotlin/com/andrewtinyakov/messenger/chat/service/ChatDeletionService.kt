package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.deletion.DeletionRequest
import com.andrewtinyakov.messenger.chat.deletion.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.DeletionService
import com.andrewtinyakov.messenger.chat.deletion.DeletionTarget
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.springframework.stereotype.Service

@Service
class ChatDeletionService(
    private val deletions: DeletionService,
) {
    fun delete(chatId: ChatId, userId: UserId) {
        deletions.delete(chatId, userId, DeletionRequest(chatId.value, DeletionScope.EVERYONE, DeletionTarget.CHAT))
    }
}
