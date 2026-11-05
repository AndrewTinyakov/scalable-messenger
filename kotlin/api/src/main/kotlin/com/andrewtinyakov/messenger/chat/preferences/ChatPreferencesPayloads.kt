package com.andrewtinyakov.messenger.chat.preferences

import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.fasterxml.jackson.annotation.JsonInclude
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.Size
import java.time.OffsetDateTime

data class PinnedChatsResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, description = "Pinned chat IDs in display order")
    val chatIds: List<String>,
)

data class ReorderPinnedChatsRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, description = "Every currently pinned chat ID in the new order")
    @field:Size(max = ChatPreferences.MAX_PINNED_CHATS)
    val chatIds: List<String>,
)

data class MuteChatRequest(
    @field:Schema(
        requiredMode = Schema.RequiredMode.NOT_REQUIRED,
        nullable = true,
        minimum = "60",
        maximum = "31622400",
        description = "Mute length in seconds; omit or null to mute until unmuted",
    )
    val durationSeconds: Long? = null,
)

data class ChatPreferencesResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val chatId: String,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true, minimum = "1", maximum = "10")
    val pinnedRank: Int?,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val mutedUntil: OffsetDateTime?,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val mutedForever: Boolean,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val markedUnread: Boolean,
)

fun ChatPreferences.toResponse(chatId: String) = ChatPreferencesResponse(chatId, pinnedRank, mutedUntil, mutedForever, markedUnread)
