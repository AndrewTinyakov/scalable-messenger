package com.andrewtinyakov.messenger.message.change.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.change.model.MessageChange
import com.andrewtinyakov.messenger.message.change.model.MutationCursor
import com.andrewtinyakov.messenger.message.model.MessageId
import java.time.OffsetDateTime

interface MessageChangeRepository {
    fun cursor(chatId: ChatId, userId: UserId): MutationCursor?

    fun page(chatId: ChatId, afterRevision: Long, throughRevision: Long, limit: Int): List<MessageChange>

    fun edit(chatId: ChatId, messageId: MessageId, body: String, now: OffsetDateTime): Long

    fun prune(before: OffsetDateTime, limit: Int): Int
}
