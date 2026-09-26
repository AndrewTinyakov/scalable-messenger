package com.andrewtinyakov.messenger.conversation

import com.andrewtinyakov.messenger.auth.UserView
import com.andrewtinyakov.messenger.shared.ApiException
import com.andrewtinyakov.messenger.shared.newId
import com.andrewtinyakov.messenger.shared.requireId
import org.jooq.exception.DataAccessException
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate

data class ConversationView(
    val id: String,
    val kind: String,
    val name: String?,
    val members: List<UserView>,
    val lastSequence: String,
)

data class DirectRequest(
    val userId: String,
)

data class GroupRequest(
    val name: String,
    val memberIds: List<String>,
)

data class AuthorizationView(
    val allowed: Boolean,
    val room: String,
    val version: Int,
)

@Service
class ConversationService(
    private val repository: ConversationRepository,
    private val tx: TransactionTemplate,
) {
    fun list(userId: String): List<ConversationView> {
        val ids = repository.listIds(userId)
        return ids.map { detail(it, userId) }
    }

    fun direct(userId: String, input: DirectRequest): ConversationView {
        val other = requireId(input.userId)
        if (other == userId) throw ApiException(400, "INVALID_MEMBERS", "A direct conversation needs another user")
        requireUser(other)
        val key = listOf(userId, other).sorted().joinToString(":")
        val existing = repository.findByDirectKey(key)
        if (existing != null) return detail(existing, userId)
        try {
            val id = tx.execute {
                val created = newId()
                repository.insertDirect(created, key)
                repository.insertMembers(created, listOf(userId, other))
                created
            }!!
            return detail(id, userId)
        } catch (error: DataAccessException) {
            if (error.sqlState() != "23505") throw error
            val id = repository.findByDirectKey(key)!!
            return detail(id, userId)
        }
    }

    fun group(userId: String, input: GroupRequest): ConversationView {
        val name = input.name.trim()
        if (name.length !in 1..80) throw ApiException(400, "INVALID_NAME", "Group name must be 1 to 80 characters")
        val members = (input.memberIds + userId).distinct()
        if (members.size !in 2..50) throw ApiException(400, "INVALID_MEMBERS", "Group needs 2 to 50 members")
        members.forEach {
            requireId(it)
            requireUser(it)
        }
        val id = tx.execute {
            val created = newId()
            repository.insertGroup(created, name, userId)
            repository.insertMembers(created, members)
            created
        }!!
        return detail(id, userId)
    }

    fun detail(conversationId: String, userId: String): ConversationView {
        requireMember(conversationId, userId)
        val row = repository.find(conversationId) ?: throw ApiException(404, "NOT_FOUND", "Conversation not found")
        return ConversationView(conversationId, row.kind, row.name, repository.members(conversationId), (row.nextSequence - 1).toString())
    }

    fun authorize(conversationId: String, userId: String): AuthorizationView {
        requireMember(conversationId, userId)
        val kind = repository.find(conversationId)!!.kind
        return AuthorizationView(true, if (kind == "direct") "user:$userId" else "group:$conversationId", 1)
    }

    fun removeMember(conversationId: String, actorId: String, memberId: String) {
        requireId(conversationId)
        requireId(memberId)
        tx.executeWithoutResult {
            val owner = repository.lockGroupOwner(conversationId) ?: throw ApiException(404, "NOT_FOUND", "Group not found")
            if (owner != actorId) throw ApiException(403, "FORBIDDEN", "Only the group owner can remove members")
            if (memberId == owner) throw ApiException(400, "INVALID_MEMBER", "The group owner cannot be removed")
            if (!repository.deleteMember(conversationId, memberId)) throw ApiException(404, "MEMBER_NOT_FOUND", "Member not found")
        }
    }

    fun requireMember(conversationId: String, userId: String) {
        requireId(conversationId)
        val found = repository.isMember(conversationId, userId)
        if (!found) throw ApiException(404, "NOT_FOUND", "Conversation not found")
    }

    private fun requireUser(userId: String) {
        val found = repository.userExists(userId)
        if (!found) throw ApiException(404, "USER_NOT_FOUND", "User not found")
    }
}
