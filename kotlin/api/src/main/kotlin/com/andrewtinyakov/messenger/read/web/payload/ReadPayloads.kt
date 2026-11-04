package com.andrewtinyakov.messenger.read.web.payload

import com.andrewtinyakov.messenger.shared.web.StrictStringDeserializer
import com.fasterxml.jackson.annotation.JsonInclude
import io.swagger.v3.oas.annotations.media.Schema
import tools.jackson.databind.annotation.JsonDeserialize
import java.time.OffsetDateTime

data class AdvanceReadRequest(
    @field:JsonDeserialize(using = StrictStringDeserializer::class)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val throughSequence: String,
)

data class ReadProgressResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val throughSequence: String,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val readAt: OffsetDateTime?,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val serverTime: OffsetDateTime,
)

data class ReadSummaryResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val throughSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val maxOtherReadSequence: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val serverTime: OffsetDateTime,
)

data class MessageReaderResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val userId: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val username: String,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val readAt: OffsetDateTime,
)

data class MessageReadsResponse(
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val readers: List<MessageReaderResponse>,
    @field:JsonInclude(JsonInclude.Include.ALWAYS)
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED, nullable = true)
    val nextUserId: String?,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val detailsAvailable: Boolean,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val detailsExpiresAt: OffsetDateTime,
    @field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)
    val serverTime: OffsetDateTime,
)
