package com.andrewtinyakov.messenger.chat.deletion.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.chat.deletion.service.DeletionService
import com.andrewtinyakov.messenger.chat.deletion.web.payload.DeletionRequest
import com.andrewtinyakov.messenger.chat.deletion.web.payload.DeletionResponse
import com.andrewtinyakov.messenger.chat.deletion.web.payload.toCommand
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.web.payload.MessageVisibilityResponse
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats/{id}")
class DeletionController(
    private val deletionService: DeletionService,
    private val messageHistoryService: MessageHistoryService,
) {
    @PostMapping("/deletions")
    fun delete(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestBody input: DeletionRequest,
    ): DeletionResponse =
        deletionService.delete(ChatId.parse(id), session.userId, input.toCommand())

    @GetMapping("/deletions/{operationId}")
    fun status(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable operationId: String,
    ): DeletionResponse =
        deletionService.status(ChatId.parse(id), session.userId, RequestId.parse(operationId))

    @GetMapping("/visibility")
    fun visibility(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): MessageVisibilityResponse =
        messageHistoryService.visibility(ChatId.parse(id), session.userId)
}
