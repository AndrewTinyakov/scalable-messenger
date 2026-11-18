package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.visibility.HiddenRange
import com.andrewtinyakov.messenger.message.model.visibility.VisibilitySnapshot

interface MessageVisibilityRepository {
    fun snapshot(chatId: ChatId, userId: UserId): VisibilitySnapshot?

    fun containing(chatId: ChatId, userId: UserId, sequence: Long): HiddenRange?

    fun next(chatId: ChatId, userId: UserId, after: Long): HiddenRange?

    fun previous(chatId: ChatId, userId: UserId, before: Long): HiddenRange?
}
