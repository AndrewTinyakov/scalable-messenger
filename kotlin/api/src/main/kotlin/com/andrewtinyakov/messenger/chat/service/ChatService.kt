package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.chat.repository.ChatDirectoryRepository
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.GroupMembershipRepository
import com.andrewtinyakov.messenger.chat.web.payload.ChatPageResponse
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.toResponse
import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MembershipChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.model.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.forbidden
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import com.andrewtinyakov.messenger.shared.web.userNotFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper

@Service
class ChatService(
    private val repository: ChatRepository,
    private val directory: ChatDirectoryRepository,
    private val memberships: GroupMembershipRepository,
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
) {
    fun list(
        userId: UserId,
        cursor: String?,
        limit: Int,
    ): ChatPageResponse {
        requirePageLimit(limit)
        val position = cursor?.let(ChatCursor::decode)
        val fetched = directory.findByMember(
            userId = userId,
            beforeActivityAt = position?.activityAt,
            beforeChatId = position?.chatId,
            limit = limit + 1,
        )
        val pinned = if (position == null) {
            directory.findByMember(
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
        val members = directory.findMembersByChatIds(
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
        if (groupName.length !in 1..80) {
            badRequest(ApiErrorCode.INVALID_NAME, "Group name must be 1 to 80 characters")
        }
        val members = (memberIds + userId).distinct()
        if (members.size !in 2..1000) {
            badRequest(ApiErrorCode.INVALID_MEMBERS, "Initial group needs 2 to 1000 members")
        }
        return tx.observedExecute(DatabaseTransaction.CHAT_CREATE_GROUP) {
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
            repository.insertGroupWithMembersAndEvents(
                id = chat.id,
                name = groupName,
                ownerId = userId,
                members = members,
                events = createdEvents(
                    chatId = chat.id,
                    members = members,
                ),
            )
            get(chat.id, userId)
        }
    }

    fun get(
        chatId: ChatId,
        userId: UserId,
    ): ChatResponse {
        val details = directory.findMemberDetails(
            chatId = chatId,
            userId = userId,
        ) ?: notFound()
        return details.chat.toResponse(members = details.members)
    }

    fun addMembers(
        chatId: ChatId,
        actorId: UserId,
        memberIds: List<UserId>,
    ) {
        val requested = memberIds.distinct()
        tx.observedExecuteWithoutResult(DatabaseTransaction.CHAT_ADD_MEMBERS) {
            val chat = lockOwnedGroup(chatId, actorId)
            requireUsersAndLock(requested)
            val additions = newMembers(chatId, requested)
            requireMemberLimit(chat, additions)
            if (additions.isNotEmpty()) addAndAnnounceMembers(chatId, additions)
        }
    }

    private fun lockOwnedGroup(chatId: ChatId, actorId: UserId): Chat {
        val chat = repository.findByIdForUpdate(chatId = chatId)
            ?.takeIf { it.kind == ChatKind.GROUP } ?: notFound()
        if (chat.ownerId != actorId) forbidden("Only the group owner can add members")
        return chat
    }

    private fun newMembers(chatId: ChatId, requested: List<UserId>): List<UserId> {
        val existing = repository.existingMemberIds(
            chatId = chatId,
            userIds = requested,
        )
        return requested.filterNot(existing::contains)
    }

    private fun requireMemberLimit(chat: Chat, additions: List<UserId>) {
        if (chat.memberCount + additions.size > 100_000) {
            badRequest(ApiErrorCode.INVALID_MEMBERS, "Group cannot exceed 100000 members")
        }
    }

    private fun addAndAnnounceMembers(chatId: ChatId, additions: List<UserId>) {
        requireGroupCapacity(additions)
        memberships.insertMembersAndIncrementCount(
            chatId = chatId,
            userIds = additions,
        )
        val membershipChanged = MembershipChangedEventV1.create(
            eventId = newId(),
            room = RoomAddress.group(chatId),
            chatId = chatId.value,
        )
        outboxRepository.enqueue(
            messages = createdEvents(
                chatId = chatId,
                members = additions,
            ) + membershipChanged.toOutboxMessage(mapper),
        )
    }

    private fun requireUsersAndLock(userIds: List<UserId>) {
        if (memberships.lockUsers(userIds = userIds).size != userIds.size) userNotFound()
    }

    private fun requireGroupCapacity(userIds: List<UserId>) {
        if (memberships.groupCountsByUser(userIds = userIds).values.any { it >= 200 }) {
            badRequest(ApiErrorCode.INVALID_MEMBERS, "A member cannot join more than 200 groups")
        }
    }

    private fun createdEvents(
        chatId: ChatId,
        members: List<UserId>,
    ): List<OutboxMessage> =
        members.map { userId ->
            ChatCreatedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(userId),
                chatId = chatId.value,
                requestId = null,
            ).toOutboxMessage(mapper)
        }
}
