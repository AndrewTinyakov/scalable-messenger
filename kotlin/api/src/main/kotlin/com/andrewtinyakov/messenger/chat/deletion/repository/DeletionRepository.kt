package com.andrewtinyakov.messenger.chat.deletion.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionChat
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionCommand
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionMessage
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId

interface DeletionRepository {
    fun lockRequest(actorId: UserId, requestId: RequestId)

    fun operation(actorId: UserId, requestId: RequestId): StoredDeletion?

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
        command: DeletionCommand,
        fingerprint: String,
        chat: DeletionChat,
        revision: Long,
        visibility: Long,
        rows: Int,
    )
}
