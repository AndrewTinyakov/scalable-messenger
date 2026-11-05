package com.andrewtinyakov.messenger.message.pin

import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.fasterxml.jackson.annotation.JsonInclude
import io.swagger.v3.oas.annotations.media.Schema

data class PinMessageRequest(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, description = "SELF is available only in direct chats")
    val scope: PinScope,
)

data class PinnedMessageResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val message: MessageResponse,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, description = "EVERYONE when any member-visible pin exists")
    val scope: PinScope,
)

data class PinnedMessagePageResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, description = "Newest pinned messages first")
    val pins: List<PinnedMessageResponse>,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, minimum = "0", maximum = "400")
    val totalCount: Int,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true, description = "Pass as beforeSequence for older pins")
    val nextBeforeSequence: String?,
)
