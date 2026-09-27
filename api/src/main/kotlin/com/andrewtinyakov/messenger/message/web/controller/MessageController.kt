package com.andrewtinyakov.messenger.message.web.controller

import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.web.payload.MessageHistoryResponse
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats")
class MessageController(
    private val auth: AuthenticationService,
    private val history: MessageHistoryService,
) {
    @GetMapping("/{id}/messages")
    fun messages(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
        @RequestParam(required = false) afterSeq: String?,
        @RequestParam(required = false) beforeSeq: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): MessageHistoryResponse = history.messages(id, auth.session(bearer).userId, afterSeq, beforeSeq, limit)
}
