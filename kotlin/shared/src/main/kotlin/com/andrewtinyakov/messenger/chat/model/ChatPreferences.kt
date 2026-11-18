package com.andrewtinyakov.messenger.chat.model

import java.time.OffsetDateTime

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
