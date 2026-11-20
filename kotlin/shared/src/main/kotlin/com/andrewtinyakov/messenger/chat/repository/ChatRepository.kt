package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage

interface ChatRepository {
    fun existingMemberIds(chatId: ChatId, userIds: List<UserId>): Set<UserId>

    fun findByDirectKey(key: String): ChatId?

    fun lockDirectPair(key: String)

    fun findByIdForUpdate(chatId: ChatId): Chat?

    fun insertDirectWithMembersAndEvents(id: ChatId, key: String, members: List<UserId>, events: List<OutboxMessage>)

    fun insertGroupWithMembersAndEvents(id: ChatId, name: String, ownerId: UserId, members: List<UserId>, events: List<OutboxMessage>)

    fun isMember(chatId: ChatId, userId: UserId): Boolean

    fun allocateSequencesForMembers(chatId: ChatId, userIds: List<UserId>, recordActivity: Boolean = true): Long?

    fun allocateEventSequence(chatId: ChatId, actorId: UserId): Long? =
        allocateSequencesForMembers(chatId, listOf(actorId), recordActivity = false)

    fun allocateMemberSequence(chatId: ChatId, userId: UserId): Long?

    fun findMemberIds(chatId: ChatId): List<UserId>
}
