package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.chat.model.ChatId

interface GroupMembershipRepository {
    fun lockUsers(userIds: List<UserId>): Set<UserId>

    fun groupCountsByUser(userIds: List<UserId>): Map<UserId, Int>

    fun insertMembersAndIncrementCount(chatId: ChatId, userIds: List<UserId>)

    fun findGroupMemberPage(chatId: ChatId, viewerId: UserId, afterUserId: UserId?, limit: Int): List<UserSummary>?

    fun groupMemberships(chatIds: List<ChatId>, userId: UserId): Set<ChatId>

    fun deleteMemberAndDecrementCount(chatId: ChatId, userId: UserId): Boolean
}
