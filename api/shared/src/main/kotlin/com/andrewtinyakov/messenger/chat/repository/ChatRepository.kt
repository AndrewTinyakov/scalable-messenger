package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.user.model.User
import java.time.OffsetDateTime

data class MemberChat(
    val chat: Chat,
    val joinedAt: OffsetDateTime,
    val memberCount: Int,
)

interface ChatRepository {
    fun findByMember(userId: String, beforeJoinedAt: OffsetDateTime?, beforeChatId: String?, limit: Int): List<MemberChat>

    fun findMembersByChatIds(chatIds: List<String>): Map<String, List<User>>

    fun countMembers(chatId: String): Int

    fun existingMemberIds(chatId: String, userIds: List<String>): Set<String>

    fun lockUsers(userIds: List<String>)

    fun groupCountsByUser(userIds: List<String>): Map<String, Int>

    fun findByDirectKey(key: String): String?

    fun lockDirectPair(key: String)

    fun findKindForUpdate(chatId: String): ChatKind?

    fun insertDirect(id: String, key: String)

    fun insertGroup(id: String, name: String, ownerId: String)

    fun insertMembers(chatId: String, userIds: List<String>)

    fun findById(chatId: String): Chat?

    fun findMembers(chatId: String): List<User>

    fun isMember(chatId: String, userId: String): Boolean

    fun isGroupMember(chatId: String, userId: String): Boolean

    fun groupMemberships(chatIds: List<String>, userId: String): Set<String>

    fun allocateSequence(chatId: String): Long

    fun findMemberIds(chatId: String): List<String>

    fun findGroupOwnerForUpdate(chatId: String): String?

    fun deleteMember(chatId: String, userId: String): Boolean
}
