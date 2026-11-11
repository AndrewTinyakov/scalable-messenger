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
        require(memberCount in 0..100_000) { "Chat member count must be 0 to 100000" }
        when (kind) {
            ChatKind.DIRECT -> {
                require(name == null) { "Direct chat cannot have a group name" }
                require(ownerId == null) { "Direct chat cannot have an owner" }
            }

            ChatKind.GROUP -> {
                require(name != null && name.isNotBlank() && name.length <= 80) {
                    "Group name must be 1 to 80 characters"
                }
                require(ownerId != null) { "Group chat requires an owner" }
            }
        }
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
