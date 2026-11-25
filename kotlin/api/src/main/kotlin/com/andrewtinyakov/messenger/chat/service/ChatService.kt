package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.chat.messaging.ChatOutbox
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatCursor
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.directory.ChatDirectoryRepository
import com.andrewtinyakov.messenger.chat.repository.membership.GroupMembershipRepository
import com.andrewtinyakov.messenger.chat.web.payload.ChatPageResponse
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.invalidInput
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import com.andrewtinyakov.messenger.shared.web.userNotFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate

@Service
class ChatService(
    private val chatRepository: ChatRepository,
    private val chatDirectoryRepository: ChatDirectoryRepository,
    private val groupMembershipRepository: GroupMembershipRepository,
    private val userRepository: UserRepository,
    private val chatOutbox: ChatOutbox,
    private val tx: TransactionTemplate,
) {
    fun list(
        userId: UserId,
        cursor: String?,
        limit: Int,
    ): ChatPageResponse {
        requirePageLimit(limit)
        val position = cursor?.let { ChatCursor.decode(it) ?: invalidInput("cursor", "Invalid chat cursor") }
        val fetched = chatDirectoryRepository.findByMember(
            userId = userId,
            beforeActivityAt = position?.activityAt,
            beforeChatId = position?.chatId,
            limit = limit + 1,
        )
        val pinned = if (position == null) {
            chatDirectoryRepository.findByMember(
                userId = userId,
                beforeActivityAt = null,
                beforeChatId = null,
                limit = ChatPreferences.MAX_PINNED_CHATS,
                pinned = true,
            )
        } else {
            emptyList()
        }
        val unpinned = fetched.take(limit)
        val page = pinned + unpinned
        if (page.isEmpty()) {
            return ChatPageResponse(
                chats = emptyList(),
                nextCursor = null,
            )
        }
        val chats = page.map { it.chat }
        val members = chatDirectoryRepository.findMembersByChatIds(
            chats.filter { it.kind == ChatKind.DIRECT }
                .map { it.id },
        )
        val nextCursor = unpinned.lastOrNull()?.takeIf { fetched.size > limit }?.let { ChatCursor(it.activityAt, it.chat.id).encode() }
        return ChatPageResponse(
            chats = page.map {
                it.chat.toResponse(members = members[it.chat.id].orEmpty())
            },
            nextCursor = nextCursor,
        )
    }

    fun createGroup(
        userId: UserId,
        name: String,
        memberIds: List<UserId>,
    ): ChatResponse {
        val groupName = name.trim()
        if (groupName.length !in 1..Chat.MAX_NAME_LENGTH) {
            invalidInput("name", "Group name must be 1 to ${Chat.MAX_NAME_LENGTH} characters")
        }
        val members = (memberIds + userId).distinct()
        if (members.size !in 2..Chat.MAX_INITIAL_GROUP_MEMBERS) {
            invalidInput("memberIds", "Initial group needs 2 to ${Chat.MAX_INITIAL_GROUP_MEMBERS} members")
        }
        return tx.execute {
            requireUsersAndLock(members)
            requireGroupCapacity(members)
            val chat = Chat(
                id = ChatId(newId()),
                kind = ChatKind.GROUP,
                name = groupName,
                lastSequence = 0,
                ownerId = userId,
                memberCount = members.size,
            )
            chatRepository.insertGroupWithMembersAndEvents(
                id = chat.id,
                name = groupName,
                ownerId = userId,
                members = members,
                events = chatOutbox.chatCreatedMessages(chatId = chat.id, userSeqs = allocateUserSequences(members)),
            )
            get(chat.id, userId)
        }
    }

    fun get(
        chatId: ChatId,
        userId: UserId,
    ): ChatResponse {
        val details = chatDirectoryRepository.findMemberDetails(
            chatId = chatId,
            userId = userId,
        ) ?: notFound()
        return details.chat.toResponse(members = details.members)
    }

    fun addMembers(
        chatId: ChatId,
        userId: UserId,
        memberIds: List<UserId>,
    ) {
        val requested = memberIds.distinct()
        tx.executeWithoutResult {
            val chat = lockOwnedGroup(chatId, userId)
            requireUsersAndLock(requested)
            val additions = newMembers(chatId, requested)
            requireMemberLimit(chat, additions)
            if (additions.isNotEmpty()) addAndAnnounceMembers(chatId, userId, additions)
        }
    }

    private fun lockOwnedGroup(chatId: ChatId, userId: UserId): Chat {
        val chat = chatRepository.findByIdForUpdate(chatId = chatId)
            ?.takeIf { it.kind == ChatKind.GROUP } ?: notFound()
        if (chat.ownerId != userId) forbidden("Only the group owner can add members")
        return chat
    }

    private fun newMembers(chatId: ChatId, requested: List<UserId>): List<UserId> {
        val existing = chatRepository.existingMemberIds(
            chatId = chatId,
            userIds = requested,
        )
        return requested.filterNot(existing::contains)
    }

    private fun requireMemberLimit(chat: Chat, additions: List<UserId>) {
        if (chat.memberCount + additions.size > Chat.MAX_MEMBERS) {
            invalidInput("memberIds", "Group cannot exceed ${Chat.MAX_MEMBERS} members")
        }
    }

    private fun addAndAnnounceMembers(chatId: ChatId, ownerId: UserId, additions: List<UserId>) {
        requireGroupCapacity(additions)
        groupMembershipRepository.insertMembersAndIncrementCount(
            chatId = chatId,
            userIds = additions,
        )
        val seq = checkNotNull(chatRepository.allocateEventSequence(chatId, ownerId))
        chatOutbox.enqueueMembersAdded(chatId = chatId, userSeqs = allocateUserSequences(additions), seq = seq)
    }

    private fun allocateUserSequences(userIds: List<UserId>): Map<UserId, Long> {
        val sequences = userRepository.allocateEventSequences(userIds)
        return userIds.associateWith(sequences::getValue)
    }

    private fun requireUsersAndLock(userIds: List<UserId>) {
        if (groupMembershipRepository.lockUsers(userIds = userIds).size != userIds.size) userNotFound()
    }

    private fun requireGroupCapacity(userIds: List<UserId>) {
        if (groupMembershipRepository.groupCountsByUser(userIds = userIds).values.any { it >= Chat.MAX_GROUPS_PER_USER }) {
            invalidInput("memberIds", "A member cannot join more than ${Chat.MAX_GROUPS_PER_USER} groups")
        }
    }
}
