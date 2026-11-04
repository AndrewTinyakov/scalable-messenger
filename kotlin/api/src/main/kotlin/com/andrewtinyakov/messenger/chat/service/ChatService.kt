package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.web.payload.AddGroupMembersRequest
import com.andrewtinyakov.messenger.chat.web.payload.ChatPageResponse
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.chat.web.payload.toResponse
import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxWriter
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.id.requireId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.notFound
import com.andrewtinyakov.messenger.user.repository.UserRepository
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.nio.charset.StandardCharsets
import java.time.OffsetDateTime
import java.util.Base64

@Service
class ChatService(
    private val repository: ChatRepository,
    private val users: UserRepository,
    private val membership: ChatMembershipService,
    private val outbox: OutboxWriter,
    private val mapper: ObjectMapper,
    private val tx: TransactionTemplate,
) {
    fun list(userId: String, cursor: String?, limit: Int): ChatPageResponse {
        if (limit !in 1..100) badRequest(ApiErrorCode.INVALID_LIMIT, "limit must be 1 to 100")
        val position = cursor?.let(::decodeCursor)
        val fetched = repository.findByMember(userId, position?.first, position?.second, limit + 1)
        val page = fetched.take(limit)
        if (page.isEmpty()) return ChatPageResponse(emptyList(), null)
        val chats = page.map { it.chat }
        val members = repository.findMembersByChatIds(chats.filter { it.kind == ChatKind.DIRECT }.map { it.id })
        val nextCursor = page.lastOrNull()?.takeIf { fetched.size > limit }?.let { encodeCursor(it.joinedAt, it.chat.id) }
        return ChatPageResponse(page.map { it.chat.toResponse(members[it.chat.id].orEmpty(), it.memberCount) }, nextCursor)
    }

    private fun encodeCursor(joinedAt: OffsetDateTime, chatId: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString("$joinedAt|$chatId".toByteArray(StandardCharsets.UTF_8))

    private fun decodeCursor(value: String): Pair<OffsetDateTime, String> {
        if (value.length > 256) badRequest(ApiErrorCode.INVALID_SEQUENCE, "Invalid chat cursor")
        return runCatching {
            val parts = String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8).split('|')
            require(parts.size == 2)
            val joinedAt = OffsetDateTime.parse(parts[0])
            requireId(parts[1])
            joinedAt to parts[1]
        }.getOrElse { badRequest(ApiErrorCode.INVALID_SEQUENCE, "Invalid chat cursor") }
    }

    fun createGroup(userId: String, input: CreateGroupChatRequest): ChatResponse {
        val name = input.name.trim()
        if (name.length !in 1..80) badRequest(ApiErrorCode.INVALID_NAME, "Group name must be 1 to 80 characters")
        val members = (input.memberIds + userId).distinct()
        if (members.size !in 2..1000) badRequest(ApiErrorCode.INVALID_MEMBERS, "Initial group needs 2 to 1000 members")
        members.forEach(::requireId)
        requireUsers(members)
        val id = tx.execute {
            requireGroupCapacity(members)
            val created = newId()
            repository.insertGroup(created, name, userId)
            repository.insertMembers(created, members)
            notifyCreated(created, members)
            created
        }
        return get(id, userId)
    }

    fun get(chatId: String, userId: String): ChatResponse {
        membership.requireMember(chatId, userId)
        val chat = repository.findById(chatId) ?: notFound()
        return chat.toResponse(repository.findMembers(chatId), repository.countMembers(chatId))
    }

    fun addMembers(chatId: String, actorId: String, input: AddGroupMembersRequest) {
        requireId(chatId)
        val requested = input.memberIds.distinct()
        requested.forEach(::requireId)
        requireUsers(requested)
        tx.executeWithoutResult {
            val owner = repository.findGroupOwnerForUpdate(chatId) ?: notFound()
            if (owner != actorId) throw ApiException(HttpStatus.FORBIDDEN, ApiErrorCode.FORBIDDEN, "Only the group owner can add members")
            val existing = repository.existingMemberIds(chatId, requested)
            val additions = requested.filterNot(existing::contains)
            if (repository.countMembers(chatId) + additions.size > 100_000) {
                badRequest(ApiErrorCode.INVALID_MEMBERS, "Group cannot exceed 100000 members")
            }
            if (additions.isNotEmpty()) {
                requireGroupCapacity(additions)
                repository.insertMembers(chatId, additions)
                notifyCreated(chatId, additions)
            }
        }
    }

    private fun requireUser(userId: String) {
        if (!users.existsById(userId)) throw ApiException(HttpStatus.NOT_FOUND, ApiErrorCode.USER_NOT_FOUND, "User not found")
    }

    private fun requireUsers(userIds: List<String>) {
        if (users.countExisting(userIds) != userIds.size) {
            throw ApiException(HttpStatus.NOT_FOUND, ApiErrorCode.USER_NOT_FOUND, "User not found")
        }
    }

    private fun requireGroupCapacity(userIds: List<String>) {
        repository.lockUsers(userIds)
        if (repository.groupCountsByUser(userIds).values.any { it >= 200 }) {
            badRequest(ApiErrorCode.INVALID_MEMBERS, "A member cannot join more than 200 groups")
        }
    }

    private fun notifyCreated(chatId: String, members: List<String>) {
        val messages = members.map { userId ->
            val event = ChatCreatedEventV1(
                type = "chat_created",
                version = 1,
                eventId = newId(),
                room = "user:$userId",
                chatId = chatId,
                requestId = null,
            )
            OutboxMessage(event.eventId, event.room, mapper.writeValueAsString(event))
        }
        messages.chunked(500).forEach(outbox::enqueue)
    }
}
