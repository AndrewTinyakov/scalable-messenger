package com.andrewtinyakov.messenger.message.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.web.AUTHENTICATED_SESSION_ATTRIBUTE
import com.andrewtinyakov.messenger.message.change.MessageMutationService
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.web.payload.EditMessageRequest
import com.andrewtinyakov.messenger.message.web.payload.MessageAroundResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangesResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageHistoryResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.requireId
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats")
class MessageController(
    private val messageHistoryService: MessageHistoryService,
    private val mutations: MessageMutationService,
) {
    @PatchMapping("/{id}/messages/{messageId}")
    fun edit(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable messageId: String,
        @RequestBody input: EditMessageRequest,
    ): MessageResponse = mutations.edit(
        ChatId(requireId(id)),
        session.userId,
        MessageId(requireId(messageId)),
        input.body,
        input.expectedVersion,
    )

    @DeleteMapping("/{id}/messages/{messageId}")
    fun delete(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable messageId: String,
        @RequestParam expectedVersion: String,
    ): MessageResponse = mutations.delete(ChatId(requireId(id)), session.userId, MessageId(requireId(messageId)), expectedVersion)

    @GetMapping("/{id}/messages/around")
    fun around(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam messageId: String,
        @RequestParam(defaultValue = "50") limit: Int,
    ): MessageAroundResponse = messageHistoryService.around(ChatId(requireId(id)), session.userId, MessageId(requireId(messageId)), limit)

    @GetMapping("/{id}/messages/changes")
    fun changes(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam afterRevision: String,
        @RequestParam(defaultValue = "100") limit: Int,
    ): MessageChangesResponse = messageHistoryService.changes(ChatId(requireId(id)), session.userId, afterRevision, limit)

    @GetMapping("/{id}/messages")
    fun messages(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam(required = false) afterSeq: String?,
        @RequestParam(required = false) beforeSeq: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): MessageHistoryResponse = messageHistoryService.messages(
        chatId = ChatId(requireId(id)),
        userId = session.userId,
        afterSeq = afterSeq,
        beforeSeq = beforeSeq,
        limit = limit,
    )
}
