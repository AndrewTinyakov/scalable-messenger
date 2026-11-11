package com.andrewtinyakov.messenger.message.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.change.service.MessageMutationService
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.web.payload.EditMessageRequest
import com.andrewtinyakov.messenger.message.web.payload.MessageAroundResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageChangesResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageHistoryResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageResolveRequest
import com.andrewtinyakov.messenger.message.web.payload.MessageResolveResponse
import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.shared.web.parseSequence
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats")
class MessageController(
    private val messageHistoryService: MessageHistoryService,
    private val messageMutationService: MessageMutationService,
) {
    @PatchMapping("/{id}/messages/{messageId}")
    fun edit(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable messageId: String,
        @RequestBody input: EditMessageRequest,
    ): MessageResponse = messageMutationService.edit(
        chatId = ChatId.parse(id),
        userId = session.userId,
        messageId = MessageId.parse(messageId),
        body = input.body,
        expectedVersion = messageVersion(input.expectedVersion),
    )

    @DeleteMapping("/{id}/messages/{messageId}")
    fun delete(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable messageId: String,
        @RequestParam expectedVersion: String,
    ): MessageResponse = messageMutationService.delete(
        chatId = ChatId.parse(id),
        userId = session.userId,
        messageId = MessageId.parse(messageId),
        expectedVersion = messageVersion(expectedVersion),
    )

    @GetMapping("/{id}/messages/around")
    fun around(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam(required = false) messageId: String?,
        @RequestParam(required = false) anchorSequence: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): MessageAroundResponse = messageHistoryService.around(
        chatId = ChatId.parse(id),
        userId = session.userId,
        messageId = messageId?.let(MessageId::parse),
        anchorSequence = anchorSequence?.let { sequence(it, positive = true) },
        limit = limit,
    )

    @PostMapping("/{id}/messages/resolve")
    fun resolve(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestBody input: MessageResolveRequest,
    ): MessageResolveResponse = messageHistoryService.resolve(
        ChatId.parse(id),
        session.userId,
        input.messageIds.map {
            MessageId.parse(it)
        },
    )

    @GetMapping("/{id}/messages/changes")
    fun changes(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam afterRevision: String,
        @RequestParam(defaultValue = "100") limit: Int,
    ): MessageChangesResponse = messageHistoryService.changes(
        chatId = ChatId.parse(id),
        userId = session.userId,
        after = sequence(afterRevision),
        limit = limit,
    )

    @GetMapping("/{id}/messages")
    fun messages(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam(required = false) afterSeq: String?,
        @RequestParam(required = false) beforeSeq: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): MessageHistoryResponse {
        val chatId = ChatId.parse(id)
        if (afterSeq != null && beforeSeq != null) badRequest(ApiErrorCode.INVALID_SEQUENCE, "Use either afterSeq or beforeSeq")
        return messageHistoryService.messages(
            chatId = chatId,
            userId = session.userId,
            afterSeq = afterSeq?.let { sequence(it) },
            beforeSeq = beforeSeq?.let { sequence(it, positive = true) },
            limit = limit,
        )
    }

    private fun sequence(value: String, positive: Boolean = false): Long =
        parseSequence(value)?.takeIf { !positive || it > 0 } ?: badRequest(ApiErrorCode.INVALID_SEQUENCE, "Invalid decimal sequence")

    private fun messageVersion(value: String): Long =
        parseSequence(value)?.takeIf { it > 0 }
            ?: badRequest(ApiErrorCode.INVALID_REQUEST, "expectedVersion must be a positive decimal integer")
}
