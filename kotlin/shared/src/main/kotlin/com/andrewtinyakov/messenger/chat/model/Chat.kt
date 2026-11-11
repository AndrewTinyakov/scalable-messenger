package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.message.model.MessageId
import java.time.OffsetDateTime

data class Chat(
    val id: ChatId,
    val kind: ChatKind,
    val name: String?,
    val lastSequence: Long,
    val ownerId: UserId?,
    val memberCount: Int,
    val lastMessage: ChatLastMessage? = null,
    val activityAt: OffsetDateTime? = null,
    val unreadCount: Int = 0,
    val unreadCountCapped: Boolean = false,
    val preferences: ChatPreferences = ChatPreferences(),
) {
    init {
        require(lastSequence >= 0) { "Chat sequence must be nonnegative" }
        require(memberCount in 0..MAX_MEMBERS) { "Chat member count must be 0 to $MAX_MEMBERS" }
        when (kind) {
            ChatKind.DIRECT -> {
                require(name == null) { "Direct chat cannot have a group name" }
                require(ownerId == null) { "Direct chat cannot have an owner" }
            }

            ChatKind.GROUP -> {
                require(name != null && name.isNotBlank() && name.length <= MAX_NAME_LENGTH) {
                    "Group name must be 1 to $MAX_NAME_LENGTH characters"
                }
                require(ownerId != null) { "Group chat requires an owner" }
            }
        }
    }

    companion object {
        const val MAX_NAME_LENGTH = 80
        const val MAX_MEMBERS = 100_000
        const val MAX_INITIAL_GROUP_MEMBERS = 1000
        const val MAX_ADDED_MEMBERS = 1000
        const val MAX_GROUPS_PER_USER = 200
        const val SUMMARY_WINDOW = 256
    }
}

data class ChatPreferences(
    val pinnedRank: Int? = null,
    val mutedUntil: OffsetDateTime? = null,
    val mutedForever: Boolean = false,
    val markedUnread: Boolean = false,
) {
    init {
        require(pinnedRank == null || pinnedRank in 1..MAX_PINNED_CHATS) { "Pinned rank must be 1 to $MAX_PINNED_CHATS" }
        require(!(mutedForever && mutedUntil != null)) { "A permanent mute has no end time" }
    }

    companion object {
        const val MAX_PINNED_CHATS = 10
    }
}

data class ChatLastMessage(
    val id: MessageId,
    val sequence: Long,
    val senderId: UserId,
    val senderUsername: String,
    val createdAt: OffsetDateTime,
    val bodyPreview: String,
    val deleted: Boolean,
)
