package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.web.AUTHENTICATED_SESSION_ATTRIBUTE
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.web.payload.MessageVisibilityResponse
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.requireId
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats/{id}")
class DeletionController(
    private val deletions: DeletionService,
    private val history: MessageHistoryService,
) {
    @PostMapping("/deletions")
    fun delete(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestBody input: DeletionRequest,
    ): DeletionResponse =
        deletions.delete(ChatId(requireId(id)), session.userId, input)

    @GetMapping("/deletions/{operationId}")
    fun status(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable operationId: String,
    ): DeletionResponse =
        deletions.status(ChatId(requireId(id)), session.userId, requireId(operationId))

    @GetMapping("/visibility")
    fun visibility(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
    ): MessageVisibilityResponse =
        history.visibility(ChatId(requireId(id)), session.userId)
}
