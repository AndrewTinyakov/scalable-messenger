package com.andrewtinyakov.messenger.chat.web.payload

import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.user.model.User
import com.andrewtinyakov.messenger.user.web.payload.UserResponse
import com.andrewtinyakov.messenger.user.web.payload.toResponse
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size

data class ChatResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val kind: String,
    val name: String?,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val members: List<UserResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val memberCount: Int,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val lastSequence: String,
)

data class ChatPageResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val chats: List<ChatResponse>,
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

fun Chat.toResponse(members: List<User>, memberCount: Int = members.size): ChatResponse = ChatResponse(
    id = id,
    kind = kind.value,
    name = name,
    members = members.map(User::toResponse),
    memberCount = memberCount,
    lastSequence = lastSequence.toString(),
)
