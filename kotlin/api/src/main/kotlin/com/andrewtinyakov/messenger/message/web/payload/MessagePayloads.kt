package com.andrewtinyakov.messenger.message.web.payload

import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.shared.web.StrictStringDeserializer
import com.fasterxml.jackson.annotation.JsonInclude
import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.Size
import tools.jackson.databind.annotation.JsonDeserialize
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
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val messageVersion: String,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.REQUIRED)
    val editedAt: OffsetDateTime?,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.REQUIRED)
    val deletedAt: OffsetDateTime?,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.REQUIRED)
    val replyToMessageId: String?,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.REQUIRED)
    val replySenderId: String?,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.REQUIRED)
    val replyBody: String?,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.REQUIRED)
    val replyDeleted: Boolean?,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.REQUIRED)
    val replyVersion: String?,
)

data class MessageHistoryResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val messages: List<MessageResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val nextSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val hasMore: Boolean,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val mutationRevision: String = "0",
)

enum class SendLookupStatus {
    UNKNOWN,
    SAVED,
    REJECTED,
}

data class SendStatusResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val status: SendLookupStatus,
    val chatId: String? = null,
    val messageId: String? = null,
    val sequence: String? = null,
    val reason: SendRejectionReason? = null,
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
    id = id.value,
    chatId = chatId.value,
    sequence = sequence.toString(),
    senderId = senderId.value,
    body = body,
    createdAt = createdAt,
    messageVersion = messageVersion.toString(),
    editedAt = editedAt,
    deletedAt = deletedAt,
    replyToMessageId = reply?.messageId?.value,
    replySenderId = reply?.senderId?.value,
    replyBody = reply?.body,
    replyDeleted = reply?.deleted,
    replyVersion = reply?.version?.toString(),
)

data class EditMessageRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:JsonDeserialize(using = StrictStringDeserializer::class)
    val body: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:JsonDeserialize(using = StrictStringDeserializer::class)
    val expectedVersion: String,
)

data class MessageAroundResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val anchorMessageId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val messages: List<MessageResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val hasOlder: Boolean,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val hasNewer: Boolean,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val mutationRevision: String,
)

data class MessageChangeResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val revision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val message: MessageResponse,
)

data class MessageChangesResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val changes: List<MessageChangeResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val lastRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val nextRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val resetRequired: Boolean,
)
