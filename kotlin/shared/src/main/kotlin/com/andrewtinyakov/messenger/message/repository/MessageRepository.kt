package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.SendResult
import java.time.OffsetDateTime

interface MessageRepository {
    fun findMessagesAfter(chatId: String, afterSequence: Long, limit: Int): List<Message>

    fun findMessagesBefore(chatId: String, beforeSequence: Long?, limit: Int): List<Message>

    fun lockSend(senderId: String, requestId: String)

    fun findSendResult(senderId: String, requestId: String): SendResult?

    fun findSendResults(senderId: String, requestIds: List<String>): List<SendResult>

    fun insertSendResult(result: SendResult)

    fun insertMessage(id: String, chatId: String, sequence: Long, senderId: String, body: String, createdAt: OffsetDateTime)
}
