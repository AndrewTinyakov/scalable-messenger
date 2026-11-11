package com.andrewtinyakov.messenger.chat.deletion.web.payload

import com.andrewtinyakov.messenger.shared.web.StrictStringDeserializer
import io.swagger.v3.oas.annotations.media.Schema
import tools.jackson.databind.annotation.JsonDeserialize

enum class DeletionScope { SELF, EVERYONE }

enum class DeletionTarget { MESSAGES, HISTORY, CHAT }

enum class DeletionState { ACCEPTED, COMPLETED }

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
