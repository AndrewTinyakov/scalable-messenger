package com.andrewtinyakov.messenger.chat.deletion.web.payload

import com.andrewtinyakov.messenger.chat.deletion.model.DeletionCommand
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionState
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.chat.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.StrictStringDeserializer
import com.andrewtinyakov.messenger.shared.web.badRequest
import io.swagger.v3.oas.annotations.media.Schema
import tools.jackson.databind.annotation.JsonDeserialize

data class DeletionRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    @field:JsonDeserialize(using = StrictStringDeserializer::class)
    val requestId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val scope: DeletionScope,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val target: DeletionTarget,
    @field:Schema(nullable = true)
    @field:JsonDeserialize(contentUsing = StrictStringDeserializer::class)
    val messageIds: List<String>? = null,
)

data class DeletionResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val operationId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val scope: DeletionScope,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val target: DeletionTarget,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val clearedThroughSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val mutationRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val visibilityRevision: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val state: DeletionState,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deletedRows: String,
)

fun DeletionRequest.toCommand(): DeletionCommand {
    val requestId = RequestId.parse(requestId)
    val ids = messageIds.orEmpty()
    if (target == DeletionTarget.MESSAGES) {
        if (ids.size !in 1..DeletionCommand.MAX_MESSAGE_IDS || ids.size != ids.distinct().size) {
            badRequest(ApiErrorCode.INVALID_REQUEST, "Provide 1 to 100 distinct message IDs")
        }
    } else if (messageIds != null) {
        badRequest(ApiErrorCode.INVALID_REQUEST, "messageIds is only valid for message deletion")
    }
    return DeletionCommand(
        requestId = requestId,
        scope = scope,
        target = target,
        messageIds = messageIds?.map(MessageId::parse),
    )
}

fun StoredDeletion.toResponse(): DeletionResponse = DeletionResponse(
    operationId = requestId.value,
    scope = scope,
    target = target,
    clearedThroughSequence = clearedThroughSequence.toString(),
    mutationRevision = mutationRevision.toString(),
    visibilityRevision = visibilityRevision.toString(),
    state = state,
    deletedRows = deletedRows.toString(),
)
