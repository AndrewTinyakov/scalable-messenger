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
)
