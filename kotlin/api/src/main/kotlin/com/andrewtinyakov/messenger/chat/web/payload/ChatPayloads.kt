package com.andrewtinyakov.messenger.chat.web.payload

import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.web.payload.UserResponse
import com.andrewtinyakov.messenger.auth.web.payload.toResponse
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.fasterxml.jackson.annotation.JsonInclude
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.OffsetDateTime

data class ChatResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val kind: ChatKind,
    val name: String?,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val members: List<UserResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val memberCount: Int,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val lastSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.NOT_REQUIRED, nullable = true)
    val ownerId: String? = null,
    @field:Schema(
        requiredMode = Schema.RequiredMode.NOT_REQUIRED,
        nullable = true,
        description = "Latest visible message in the newest 256 rows; null can leave older visible history",
    )
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    val lastMessage: ChatLastMessageResponse? = null,
    @field:Schema(
        requiredMode = Schema.RequiredMode.NOT_REQUIRED,
        minimum = "0",
        maximum = "256",
        description = "Visible other-author unread messages in the newest 256 candidates; lower bound when capped",
    )
    val unreadCount: Int = 0,
    @field:Schema(requiredMode = Schema.RequiredMode.NOT_REQUIRED, nullable = true)
    val activityAt: OffsetDateTime? = null,
    @field:Schema(
        requiredMode = Schema.RequiredMode.NOT_REQUIRED,
        description = "True for 256 raw unread candidates; real count may be higher even when unreadCount is zero",
    )
    val unreadCountCapped: Boolean = false,
    @field:Schema(
        requiredMode = Schema.RequiredMode.NOT_REQUIRED,
        nullable = true,
        minimum = "1",
        maximum = "10",
        description = "Viewer's pin position; pinned chats lead the first directory page",
    )
    val pinnedRank: Int? = null,
    @field:Schema(requiredMode = Schema.RequiredMode.NOT_REQUIRED, nullable = true, description = "End of a timed mute")
    val mutedUntil: OffsetDateTime? = null,
    @field:Schema(requiredMode = Schema.RequiredMode.NOT_REQUIRED)
    val mutedForever: Boolean = false,
    @field:Schema(requiredMode = Schema.RequiredMode.NOT_REQUIRED, description = "Viewer marked this chat to read later")
    val markedUnread: Boolean = false,
)

data class DirectChatResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val recipient: UserResponse,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    val chat: ChatResponse?,
)

data class ChatPageResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val chats: List<ChatResponse>,
    val nextCursor: String?,
)

data class GroupMemberPageResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val members: List<UserResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    val nextCursor: String?,
)

data class CreateGroupChatRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:NotBlank
    @field:Size(max = 80)
    val name: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:Size(min = 1, max = 999)
    val memberIds: List<String>,
)

data class AddGroupMembersRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:Size(min = 1, max = 1000)
    val memberIds: List<String>,
)

fun Chat.toResponse(members: List<UserSummary>): ChatResponse = ChatResponse(
    id = id.value,
    kind = kind,
    name = name,
    members = members.map(UserSummary::toResponse),
    memberCount = memberCount,
    lastSequence = lastSequence.toString(),
    ownerId = ownerId?.value,
    unreadCount = unreadCount,
    activityAt = activityAt,
    unreadCountCapped = unreadCountCapped,
    pinnedRank = preferences.pinnedRank,
    mutedUntil = preferences.mutedUntil,
    mutedForever = preferences.mutedForever,
    markedUnread = preferences.markedUnread,
    lastMessage = lastMessage?.let {
        ChatLastMessageResponse(
            it.id.value,
            it.sequence.toString(),
            it.senderId.value,
            it.senderUsername,
            it.createdAt,
            it.bodyPreview,
            it.deleted,
        )
    },
)

data class ChatLastMessageResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val sequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val senderId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val senderUsername: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val createdAt: OffsetDateTime,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val bodyPreview: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deleted: Boolean,
)
