package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

data class MemberChat(
    val chat: Chat,
    val joinedAt: OffsetDateTime,
)

data class MemberChatDetails(
    val chat: Chat,
    val members: List<UserSummary>,
)

interface ChatRepository {
    fun findByMember(userId: UserId, beforeJoinedAt: OffsetDateTime?, beforeChatId: ChatId?, limit: Int): List<MemberChat>

    fun findMembersByChatIds(chatIds: List<ChatId>): Map<ChatId, List<UserSummary>>

    fun existingMemberIds(chatId: ChatId, userIds: List<UserId>): Set<UserId>

    fun lockUsers(userIds: List<UserId>): Set<UserId>

    fun groupCountsByUser(userIds: List<UserId>): Map<UserId, Int>

    fun findByDirectKey(key: String): ChatId?

    fun lockDirectPair(key: String)

    fun findByIdForUpdate(chatId: ChatId): Chat?

    fun insertDirectWithMembersAndEvents(id: ChatId, key: String, members: List<UserId>, events: List<OutboxMessage>)

    fun insertGroupWithMembersAndEvents(id: ChatId, name: String, ownerId: UserId, members: List<UserId>, events: List<OutboxMessage>)

    fun insertMembersAndIncrementCount(chatId: ChatId, userIds: List<UserId>)

    fun findById(chatId: ChatId): Chat?

    fun findMemberDetails(chatId: ChatId, userId: UserId): MemberChatDetails?

    fun findGroupMemberPage(chatId: ChatId, viewerId: UserId, afterUserId: UserId?, limit: Int): List<UserSummary>?

    fun findMembers(chatId: ChatId): List<UserSummary>

    fun isMember(chatId: ChatId, userId: UserId): Boolean

    fun isGroupMember(chatId: ChatId, userId: UserId): Boolean

    fun groupMemberships(chatIds: List<ChatId>, userId: UserId): Set<ChatId>

    fun allocateSequenceForMember(chatId: ChatId, userId: UserId): Long?

    fun allocateSequencesForMembers(chatId: ChatId, userIds: List<UserId>): Long?

    fun findMemberIds(chatId: ChatId): List<UserId>

    fun deleteMemberAndDecrementCount(chatId: ChatId, userId: UserId): Boolean
}
