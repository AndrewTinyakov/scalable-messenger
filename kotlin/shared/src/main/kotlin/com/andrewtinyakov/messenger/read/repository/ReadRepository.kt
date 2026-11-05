package com.andrewtinyakov.messenger.read.repository

import com.andrewtinyakov.messenger.read.model.MessageReadTarget
import com.andrewtinyakov.messenger.read.model.MessageReader
import com.andrewtinyakov.messenger.read.model.ReadAdvance
import com.andrewtinyakov.messenger.read.model.ReadCleanup
import com.andrewtinyakov.messenger.read.model.ReadSummary
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.LocalDate
import java.time.OffsetDateTime

interface ReadRepository {
    fun requireMember(chatId: ChatId, userId: UserId): Long

    fun advance(chatId: ChatId, userId: UserId, sequence: Long): ReadAdvance

    fun summary(chatId: ChatId, userId: UserId): ReadSummary?

    fun messageTarget(chatId: ChatId, userId: UserId, messageId: MessageId): MessageReadTarget?

    fun readers(
        chatId: ChatId,
        userId: UserId,
        sequence: Long,
        creationDay: LocalDate,
        afterUserId: UserId?,
        limit: Int,
    ): List<MessageReader>

    fun notificationRooms(chatId: ChatId, now: OffsetDateTime): List<String>

    fun completeNotification(chatId: ChatId, userId: UserId)

    fun pendingNotifications(now: OffsetDateTime, limit: Int): Map<ChatId, List<String>>

    fun cleanup(now: OffsetDateTime, limit: Int): ReadCleanup?
}
