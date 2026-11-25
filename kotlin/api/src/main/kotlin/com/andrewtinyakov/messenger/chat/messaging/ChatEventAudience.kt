package com.andrewtinyakov.messenger.chat.messaging

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import org.springframework.stereotype.Component

@Component
class ChatEventAudience(
    private val chatRepository: ChatRepository,
) {
    fun rooms(chatId: ChatId, kind: ChatKind, personalViewer: UserId? = null): List<String> = when {
        personalViewer != null -> listOf(RoomAddress.user(personalViewer))
        kind == ChatKind.GROUP -> listOf(RoomAddress.group(chatId))
        else -> chatRepository.findMemberIds(chatId).map(RoomAddress::user)
    }
}
