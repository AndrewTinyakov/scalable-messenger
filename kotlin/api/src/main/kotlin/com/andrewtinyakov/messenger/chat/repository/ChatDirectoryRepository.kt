package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.MemberChat
import com.andrewtinyakov.messenger.chat.model.MemberChatDetails
import java.time.OffsetDateTime

interface ChatDirectoryRepository {
    fun findByMember(
        userId: UserId,
        beforeActivityAt: OffsetDateTime?,
        beforeChatId: ChatId?,
        limit: Int,
        pinned: Boolean = false,
    ): List<MemberChat>

    fun findMembersByChatIds(chatIds: List<ChatId>): Map<ChatId, List<UserSummary>>

    fun findById(chatId: ChatId): Chat?

    fun findMemberDetails(chatId: ChatId, userId: UserId): MemberChatDetails?
}
