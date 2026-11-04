package com.andrewtinyakov.messenger.message.web.payload

import com.andrewtinyakov.messenger.message.model.Message
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.Size
import java.time.OffsetDateTime

data class MessageResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val id: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val chatId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val sequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val senderId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val body: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val createdAt: OffsetDateTime,
)

data class MessageHistoryResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val messages: List<MessageResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val nextSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val hasMore: Boolean,
)

data class SendStatusResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val status: String,
    val chatId: String? = null,
    val messageId: String? = null,
    val sequence: String? = null,
    val reason: String? = null,
)

data class SendStatusesRequest(
    @field:Size(min = 1, max = 100)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val requestIds: List<String>,
)

data class SendStatusEntry(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val requestId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val result: SendStatusResponse,
)

data class SendStatusesResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val results: List<SendStatusEntry>,
)

fun Message.toResponse(): MessageResponse = MessageResponse(
    id = id,
    chatId = chatId,
    sequence = sequence.toString(),
    senderId = senderId,
    body = body,
    createdAt = createdAt,
)
