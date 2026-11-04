package com.andrewtinyakov.messenger.message.visibility

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId

data class HiddenRange(
    val after: Long,
    val through: Long,
)

interface VisibilityRepository {
    fun snapshot(chatId: ChatId, userId: UserId): VisibilitySnapshot?

    fun containing(chatId: ChatId, userId: UserId, sequence: Long): HiddenRange?

    fun next(chatId: ChatId, userId: UserId, after: Long): HiddenRange?

    fun previous(chatId: ChatId, userId: UserId, before: Long): HiddenRange?
}
