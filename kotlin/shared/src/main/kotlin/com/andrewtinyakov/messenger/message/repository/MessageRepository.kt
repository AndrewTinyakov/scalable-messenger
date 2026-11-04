package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.SavedMessage
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId

interface MessageRepository {
    fun findMessagesForPublication(messageIds: List<MessageId>): List<Message>

    fun findMessagesInSpan(chatId: ChatId, userId: UserId, after: Long, through: Long, ascending: Boolean, limit: Int): List<Message>

    fun findMessagesByIds(chatId: ChatId, userId: UserId, messageIds: List<MessageId>): List<Message>

    fun findMessage(chatId: ChatId, userId: UserId, messageId: MessageId): Message?

    fun findReply(chatId: ChatId, userId: UserId, messageId: MessageId): Message?

    fun findMessagesAfter(chatId: ChatId, userId: UserId, afterSequence: Long, limit: Int): List<Message>

    fun findMessagesBefore(chatId: ChatId, userId: UserId, beforeSequence: Long?, limit: Int): List<Message>

    fun lockSend(senderId: UserId, requestId: RequestId)

    fun findSendResult(senderId: UserId, requestId: RequestId): SendResult?

    fun findSendResults(senderId: UserId, requestIds: List<RequestId>): List<SendResult>

    fun findSendResults(requests: Map<UserId, List<RequestId>>): List<SendResult>

    fun insertSendResult(result: SendResult)

    fun insertSavedMessage(message: Message, result: SendResult)

    fun insertSavedMessages(messages: List<SavedMessage>)
}
