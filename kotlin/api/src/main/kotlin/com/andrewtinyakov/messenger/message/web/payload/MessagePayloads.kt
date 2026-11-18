package com.andrewtinyakov.messenger.message.web.payload

import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.model.Message
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.visibility.VisibilitySnapshot
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
    @field:Schema(nullable = true, requiredMode = Schema.RequiredMode.NOT_REQUIRED, description = "Original author of a forwarded message")
    val forwardedFromUserId: String? = null,
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
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val snapshotSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val visibilityRevision: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val clearedThroughSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val globalClearedThroughSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val coverageAfterSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val coverageThroughSequence: String = "0",
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
    @field:Size(min = 1, max = SendResult.MAX_LOOKUP_REQUEST_IDS)
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
    replyToMessageId = replyToMessageId?.value,
    replySenderId = reply?.senderId?.value,
    replyBody = reply?.body,
    replyDeleted = reply?.deleted,
    replyVersion = reply?.version?.toString(),
    forwardedFromUserId = forwardedFromUserId?.value,
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
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val anchorMessageId: String?,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val messages: List<MessageResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val hasOlder: Boolean,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val hasNewer: Boolean,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val mutationRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val snapshotSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val visibilityRevision: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val clearedThroughSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val globalClearedThroughSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val coverageAfterSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val coverageThroughSequence: String = "0",
)

enum class MessageChangeKind { UPSERT, REMOVED, CLEARED }

data class MessageChangeResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val revision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val kind: MessageChangeKind,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val message: MessageResponse? = null,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val messageId: String? = null,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val sequence: String? = null,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val clearedThroughSequence: String? = null,
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
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val snapshotSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val visibilityRevision: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val clearedThroughSequence: String = "0",
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val globalClearedThroughSequence: String = "0",
)

data class MessageResolveRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:JsonDeserialize(contentUsing = StrictStringDeserializer::class)
    val messageIds: List<String>,
)

data class MessageResolveResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val messages: List<MessageResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val snapshotSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val mutationRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val visibilityRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val clearedThroughSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val globalClearedThroughSequence: String,
)

data class MessageVisibilityResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val snapshotSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val mutationRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val visibilityRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val clearedThroughSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val globalClearedThroughSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val hidden: Boolean,
)

fun VisibilitySnapshot.toVisibilityResponse(): MessageVisibilityResponse = MessageVisibilityResponse(
    snapshotSequence = snapshotSequence.toString(),
    mutationRevision = mutationRevision.toString(),
    visibilityRevision = visibilityRevision.toString(),
    clearedThroughSequence = clearedThroughSequence.toString(),
    globalClearedThroughSequence = globalClearedThroughSequence.toString(),
    hidden = hidden,
)

fun VisibilitySnapshot.toHistoryResponse(
    messages: List<Message>,
    nextSequence: Long,
    hasMore: Boolean,
    coverageAfterSequence: Long,
    coverageThroughSequence: Long,
): MessageHistoryResponse = toVisibilityResponse().let { visibility ->
    MessageHistoryResponse(
        messages = messages.map { it.toResponse() },
        nextSequence = nextSequence.toString(),
        hasMore = hasMore,
        mutationRevision = visibility.mutationRevision,
        snapshotSequence = visibility.snapshotSequence,
        visibilityRevision = visibility.visibilityRevision,
        clearedThroughSequence = visibility.clearedThroughSequence,
        globalClearedThroughSequence = visibility.globalClearedThroughSequence,
        coverageAfterSequence = coverageAfterSequence.toString(),
        coverageThroughSequence = coverageThroughSequence.toString(),
    )
}

fun VisibilitySnapshot.toAroundResponse(
    anchorMessageId: MessageId?,
    messages: List<Message>,
    hasOlder: Boolean,
    hasNewer: Boolean,
    coverageAfterSequence: Long,
    coverageThroughSequence: Long,
): MessageAroundResponse = toVisibilityResponse().let { visibility ->
    MessageAroundResponse(
        anchorMessageId = anchorMessageId?.value,
        messages = messages.map { it.toResponse() },
        hasOlder = hasOlder,
        hasNewer = hasNewer,
        mutationRevision = visibility.mutationRevision,
        snapshotSequence = visibility.snapshotSequence,
        visibilityRevision = visibility.visibilityRevision,
        clearedThroughSequence = visibility.clearedThroughSequence,
        globalClearedThroughSequence = visibility.globalClearedThroughSequence,
        coverageAfterSequence = coverageAfterSequence.toString(),
        coverageThroughSequence = coverageThroughSequence.toString(),
    )
}

fun VisibilitySnapshot.toResolveResponse(messages: List<Message>): MessageResolveResponse = toVisibilityResponse().let { visibility ->
    MessageResolveResponse(
        messages = messages.map { it.toResponse() },
        snapshotSequence = visibility.snapshotSequence,
        mutationRevision = visibility.mutationRevision,
        visibilityRevision = visibility.visibilityRevision,
        clearedThroughSequence = visibility.clearedThroughSequence,
        globalClearedThroughSequence = visibility.globalClearedThroughSequence,
    )
}

fun VisibilitySnapshot.toChangesResponse(
    changes: List<MessageChangeResponse>,
    lastRevision: Long,
    nextRevision: Long,
    resetRequired: Boolean,
): MessageChangesResponse = toVisibilityResponse().let { visibility ->
    MessageChangesResponse(
        changes = changes,
        lastRevision = lastRevision.toString(),
        nextRevision = nextRevision.toString(),
        resetRequired = resetRequired,
        snapshotSequence = visibility.snapshotSequence,
        visibilityRevision = visibility.visibilityRevision,
        clearedThroughSequence = visibility.clearedThroughSequence,
        globalClearedThroughSequence = visibility.globalClearedThroughSequence,
    )
}
