package com.andrewtinyakov.messenger.read.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.read.service.ReadService
import com.andrewtinyakov.messenger.read.web.payload.AdvanceReadRequest
import com.andrewtinyakov.messenger.read.web.payload.MessageReadsResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadProgressResponse
import com.andrewtinyakov.messenger.read.web.payload.ReadSummaryResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.parseSequence
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats/{id}")
class ReadController(
    private val readService: ReadService,
) {
    @PostMapping("/reads")
    fun advance(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestBody input: AdvanceReadRequest,
    ): ReadProgressResponse {
        val chatId = ChatId.parse(id)
        val throughSequence = parseSequence(input.throughSequence)
            ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "throughSequence must be a nonnegative decimal integer")
        return readService.advance(chatId = chatId, userId = session.userId, throughSequence = throughSequence)
    }

    @GetMapping("/reads")
    fun summary(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): ReadSummaryResponse = readService.summary(ChatId.parse(id), session.userId)

    @GetMapping("/messages/{messageId}/reads")
    fun readers(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable messageId: String,
        @RequestParam(required = false) afterUserId: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): MessageReadsResponse = readService.readers(
        chatId = ChatId.parse(id),
        userId = session.userId,
        messageId = MessageId.parse(messageId),
        afterUserId = afterUserId?.let(UserId::parse),
        limit = limit,
    )
}
