package com.andrewtinyakov.messenger.message.pin

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats/{id}/pins")
class MessagePinController(
    private val service: MessagePinService,
) {
    @GetMapping
    fun list(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam(required = false) beforeSequence: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): PinnedMessagePageResponse = service.list(ChatId.parse(id), session.userId, beforeSequence, limit)

    @PutMapping("/{messageId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun pin(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable messageId: String,
        @RequestBody input: PinMessageRequest,
    ) = service.pin(ChatId.parse(id), session.userId, MessageId.parse(messageId), input.scope)

    @DeleteMapping("/{messageId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun unpin(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable messageId: String,
    ) = service.unpin(ChatId.parse(id), session.userId, MessageId.parse(messageId))

    @DeleteMapping
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun unpinAll(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ) = service.unpinAll(ChatId.parse(id), session.userId)
}
