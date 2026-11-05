package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.web.payload.AddGroupMembersRequest
import com.andrewtinyakov.messenger.chat.web.payload.ChatPageResponse
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.chat.web.payload.toResponse
import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MembershipChangedEventV1
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecute
import com.andrewtinyakov.messenger.infrastructure.database.observability.observedExecuteWithoutResult
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.id.requireId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.shared.web.requirePageLimit
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.OffsetDateTime

@Service
class ChatService(
    private val repository: ChatRepository,
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
        val fetched = repository.findByMember(
            userId = userId,
            beforeActivityAt = position?.activityAt,
            beforeChatId = position?.chatId,
            limit = limit + 1,
        )
        val pinned = if (position == null) {
            repository.findByMember(userId, null, null, ChatPreferences.MAX_PINNED_CHATS, pinned = true)
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
        val members = repository.findMembersByChatIds(
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
        input: CreateGroupChatRequest,
    ): ChatResponse {
        val name = input.name.trim()
        if (name.length !in 1..80) {
            badRequest(ApiErrorCode.INVALID_NAME, "Group name must be 1 to 80 characters")
        }
        val members = (input.memberIds.map { UserId.parse(it) } + userId).distinct()
        if (members.size !in 2..1000) {
            badRequest(ApiErrorCode.INVALID_MEMBERS, "Initial group needs 2 to 1000 members")
        }
        return tx.observedExecute(DatabaseTransaction.CHAT_CREATE_GROUP) {
            requireUsersAndLock(members)
            requireGroupCapacity(members)
            val chat = Chat(
                id = ChatId(newId()),
                kind = ChatKind.GROUP,
                name = name,
                lastSequence = 0,
                ownerId = userId,
                memberCount = members.size,
            )
            repository.insertGroupWithMembersAndEvents(
                id = chat.id,
                name = name,
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
        val details = repository.findMemberDetails(
            chatId = chatId,
            userId = userId,
        ) ?: notFound()
        return details.chat.toResponse(members = details.members)
    }

    fun addMembers(
        chatId: ChatId,
        actorId: UserId,
        input: AddGroupMembersRequest,
    ) {
        val requested = input.memberIds.map { UserId.parse(it) }
            .distinct()
        tx.observedExecuteWithoutResult(DatabaseTransaction.CHAT_ADD_MEMBERS) {
            val chat = repository.findByIdForUpdate(chatId = chatId)
                ?.takeIf { it.kind == ChatKind.GROUP } ?: notFound()
            if (chat.ownerId != actorId) {
                throw ApiException(
                    HttpStatus.FORBIDDEN,
                    ApiErrorCode.FORBIDDEN,
                    "Only the group owner can add members",
                )
            }
            requireUsersAndLock(requested)
            val existing = repository.existingMemberIds(
                chatId = chatId,
                userIds = requested,
            )
            val additions = requested.filterNot(existing::contains)
            if (chat.memberCount + additions.size > 100_000) {
                badRequest(ApiErrorCode.INVALID_MEMBERS, "Group cannot exceed 100000 members")
            }
            if (additions.isNotEmpty()) {
                requireGroupCapacity(additions)
                repository.insertMembersAndIncrementCount(
                    chatId = chatId,
                    userIds = additions,
                )
                val event = MembershipChangedEventV1.create(
                    eventId = newId(),
                    room = RoomAddress.group(chatId),
                    chatId = chatId.value,
                )
                outboxRepository.enqueue(
                    messages = createdEvents(
                        chatId = chatId,
                        members = additions,
                    ) + OutboxMessage(
                        id = EventId(event.eventId),
                        room = event.room,
                        payload = mapper.writeValueAsString(event),
                    ),
                )
            }
        }
    }

    private fun requireUsersAndLock(userIds: List<UserId>) {
        if (repository.lockUsers(userIds = userIds).size != userIds.size) {
            throw ApiException(
                HttpStatus.NOT_FOUND,
                ApiErrorCode.USER_NOT_FOUND,
                "User not found",
            )
        }
    }

    private fun requireGroupCapacity(userIds: List<UserId>) {
        if (repository.groupCountsByUser(userIds = userIds).values.any { it >= 200 }) {
            badRequest(ApiErrorCode.INVALID_MEMBERS, "A member cannot join more than 200 groups")
        }
    }

    private fun createdEvents(
        chatId: ChatId,
        members: List<UserId>,
    ): List<OutboxMessage> =
        members.map { userId ->
            val event = ChatCreatedEventV1.create(
                eventId = newId(),
                room = RoomAddress.user(userId),
                chatId = chatId.value,
                requestId = null,
            )
            OutboxMessage(
                id = EventId(event.eventId),
                room = event.room,
                payload = mapper.writeValueAsString(event),
            )
        }
}
