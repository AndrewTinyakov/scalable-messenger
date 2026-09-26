package com.andrewtinyakov.messenger.conversation

import com.andrewtinyakov.messenger.auth.AuthService
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/conversations")
class ConversationController(
    private val auth: AuthService,
    private val conversations: ConversationService,
    private val history: HistoryService,
) {
    @GetMapping
    fun list(
        @RequestHeader("Authorization", required = false) bearer: String?,
    ): List<ConversationView> =
        conversations.list(auth.session(bearer).userId)

    @PostMapping("/direct")
    @ResponseStatus(HttpStatus.CREATED)
    fun direct(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @RequestBody input: DirectRequest,
    ): ConversationView =
        conversations.direct(auth.session(bearer).userId, input)

    @PostMapping("/groups")
    @ResponseStatus(HttpStatus.CREATED)
    fun group(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @RequestBody input: GroupRequest,
    ): ConversationView =
        conversations.group(auth.session(bearer).userId, input)

    @GetMapping("/{id}/authorization")
    fun authorize(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
    ): AuthorizationView =
        conversations.authorize(id, auth.session(bearer).userId)

    @DeleteMapping("/{id}/members/{userId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun removeMember(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
        @PathVariable userId: String,
    ) {
        conversations.removeMember(id, auth.session(bearer).userId, userId)
    }

    @GetMapping("/{id}/messages")
    fun messages(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
        @RequestParam(defaultValue = "0") afterSeq: String,
        @RequestParam(defaultValue = "50") limit: Int,
    ): HistoryView = history.messages(id, auth.session(bearer).userId, afterSeq, limit)

    @GetMapping("/{id}/send-status/{requestId}")
    fun status(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
        @PathVariable requestId: String,
    ): SendStatusView = history.status(id, auth.session(bearer).userId, requestId)
}
