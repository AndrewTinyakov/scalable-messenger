package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

data class DeletableChat(
    val kind: ChatKind,
    val ownerId: UserId?,
    val deleted: Boolean,
)

interface ChatDeletionRepository {
    fun lockForMember(chatId: ChatId, userId: UserId): DeletableChat?

    fun delete(chatId: ChatId, userId: UserId, now: OffsetDateTime)
}
