package com.andrewtinyakov.messenger.deletion.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.service.DeletionService
import com.andrewtinyakov.messenger.deletion.web.payload.DeletionRequest
import com.andrewtinyakov.messenger.deletion.web.payload.DeletionResponse
import com.andrewtinyakov.messenger.deletion.web.payload.validMessageIds
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
    ): DeletionResponse {
        val chatId = ChatId.parse(id)
        val requestId = RequestId.parse(input.requestId)
        val messageIds = input.validMessageIds()
        return when (input.target) {
            DeletionTarget.MESSAGES -> deletionService.deleteMessages(chatId, session.userId, requestId, input.scope, messageIds)
            DeletionTarget.HISTORY -> deletionService.clearHistory(chatId, session.userId, requestId, input.scope)
            DeletionTarget.CHAT -> deletionService.deleteChat(chatId, session.userId, requestId, input.scope)
        }
    }

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
