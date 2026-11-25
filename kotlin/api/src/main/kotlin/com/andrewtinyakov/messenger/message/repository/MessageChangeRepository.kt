package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.change.MessageChangePage
import com.andrewtinyakov.messenger.message.model.change.MutationCursor
import java.time.OffsetDateTime

interface MessageChangeRepository {
    fun cursor(chatId: ChatId, userId: UserId): MutationCursor?

    fun page(chatId: ChatId, afterSeq: Long, throughSeq: Long, limit: Int): MessageChangePage

    fun edit(chatId: ChatId, messageId: MessageId, body: String, now: OffsetDateTime, seq: Long)

    fun prune(before: OffsetDateTime, limit: Int): Int
}
