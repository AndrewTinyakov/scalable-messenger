package com.andrewtinyakov.messenger.deletion.web.payload

import com.andrewtinyakov.messenger.deletion.model.DeletionMessage
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionState
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.shared.web.StrictStringDeserializer
import com.andrewtinyakov.messenger.shared.web.invalidInput
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
    val seq: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val visibilitySeq: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val state: DeletionState,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val deletedRows: String,
)

fun DeletionRequest.validMessageIds(): List<MessageId> {
    val ids = messageIds.orEmpty()
    if (target == DeletionTarget.MESSAGES) {
        if (ids.size !in 1..DeletionMessage.MAX_PER_REQUEST || ids.size != ids.distinct().size) {
            invalidInput("messageIds", "Provide 1 to ${DeletionMessage.MAX_PER_REQUEST} distinct message IDs")
        }
    } else if (messageIds != null) {
        invalidInput("messageIds", "messageIds is only valid for message deletion")
    }
    return ids.map(MessageId::parse)
}

fun StoredDeletion.toResponse(): DeletionResponse = DeletionResponse(
    operationId = requestId.value,
    scope = scope,
    target = target,
    clearedThroughSequence = clearedThroughSequence.toString(),
    seq = seq.toString(),
    visibilitySeq = visibilitySeq.toString(),
    state = state,
    deletedRows = deletedRows.toString(),
)
