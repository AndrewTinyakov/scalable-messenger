package com.andrewtinyakov.messenger.message.change

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

data class MutationCursor(
    val revision: Long,
    val floor: Long,
)

data class MessageChange(
    val revision: Long,
    val messageId: MessageId?,
    val kind: String = "UPSERT",
    val sequence: Long? = null,
    val clearedThroughSequence: Long? = null,
)

interface MessageChangeRepository {
    fun cursor(chatId: ChatId, userId: UserId): MutationCursor?

    fun changes(chatId: ChatId, afterRevision: Long, throughRevision: Long, limit: Int): List<MessageChange>

    fun mutate(chatId: ChatId, messageId: MessageId, body: String, now: OffsetDateTime): Long

    fun prune(before: OffsetDateTime, limit: Int): Int
}
