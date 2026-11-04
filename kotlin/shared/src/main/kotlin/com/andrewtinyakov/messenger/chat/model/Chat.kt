package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId

data class Chat(
    val id: ChatId,
    val kind: ChatKind,
    val name: String?,
    val lastSequence: Long,
    val ownerId: UserId?,
    val memberCount: Int,
    val lastMessage: ChatLastMessage? = null,
    val unreadCount: Int = 0,
    val unreadCountCapped: Boolean = false,
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

data class ChatLastMessage(
    val id: String,
    val sequence: Long,
    val senderId: String,
    val senderUsername: String,
    val createdAt: java.time.OffsetDateTime,
    val bodyPreview: String,
    val deleted: Boolean,
)
