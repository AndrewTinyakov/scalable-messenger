package com.andrewtinyakov.messenger.deletion.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.deletion.model.DeletionChat
import com.andrewtinyakov.messenger.deletion.model.DeletionMessage
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionSequences
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId

interface DeletionRepository {
    fun lockRequest(userId: UserId, requestId: RequestId)

    fun operation(userId: UserId, requestId: RequestId): StoredDeletion?

    fun targets(chatId: ChatId, userId: UserId, ids: List<MessageId>, scope: DeletionScope): List<DeletionMessage>

    fun lockChat(chatId: ChatId, userId: UserId): DeletionChat?

    fun hideMessages(chatId: ChatId, userId: UserId, messages: List<DeletionMessage>)

    fun clearPersonal(chatId: ChatId, userId: UserId, through: Long, hide: Boolean)

    fun removeMessages(chatId: ChatId, messages: List<DeletionMessage>, seq: Long)

    fun repairClosedPurge(chatId: ChatId, through: Long)

    fun clearGlobal(chatId: ChatId, userId: UserId, through: Long, close: Boolean, seq: Long)

    fun saveOperation(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        scope: DeletionScope,
        target: DeletionTarget,
        fingerprint: String,
        chat: DeletionChat,
        sequences: DeletionSequences,
        rows: Int,
    )
}
