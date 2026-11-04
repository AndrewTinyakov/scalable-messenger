package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId

interface DeletionRepository {
    fun lockRequest(actorId: UserId, requestId: String)

    fun operation(chatId: ChatId, actorId: UserId, requestId: String): StoredDeletion?

    fun targets(chatId: ChatId, actorId: UserId, ids: List<MessageId>, scope: DeletionScope): List<DeletionMessage>

    fun lockChat(chatId: ChatId, actorId: UserId): DeletionChat?

    fun hideMessages(chatId: ChatId, actorId: UserId, messages: List<DeletionMessage>): Long

    fun clearPersonal(chatId: ChatId, actorId: UserId, through: Long, hide: Boolean): Long

    fun removeMessages(chatId: ChatId, messages: List<DeletionMessage>): Long

    fun repairClosedPurge(chatId: ChatId, through: Long)

    fun clearGlobal(chatId: ChatId, actorId: UserId, through: Long, close: Boolean): Long

    fun saveOperation(
        chatId: ChatId,
        actorId: UserId,
        request: DeletionRequest,
        fingerprint: String,
        chat: DeletionChat,
        revision: Long,
        visibility: Long,
        rows: Int,
    )
}

data class DeletionChat(
    val kind: ChatKind,
    val owner: UserId?,
    val high: Long,
    val revision: Long,
    val visibility: Long,
    val purgedRows: Long,
    val deleted: Boolean,
)

data class StoredDeletion(
    val chatId: String,
    val fingerprint: String,
    val response: DeletionResponse,
)

data class DeletionMessage(
    val id: MessageId,
    val sequence: Long,
    val senderId: UserId,
    val messageVersion: Long,
)
