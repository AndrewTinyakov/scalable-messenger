package com.andrewtinyakov.messenger.chat.web.controller

import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.AddGroupMembersRequest
import com.andrewtinyakov.messenger.chat.web.payload.ChatPageResponse
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import jakarta.validation.Valid
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
@RequestMapping("/v1/chats")
class ChatController(
    private val auth: AuthenticationService,
    private val chats: ChatService,
    private val membership: ChatMembershipService,
) {
    @GetMapping
    fun list(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @RequestParam(required = false) cursor: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): ChatPageResponse =
        chats.list(auth.session(bearer).userId, cursor, limit)

    @GetMapping("/{id}")
    fun get(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
    ): ChatResponse = chats.get(id, auth.session(bearer).userId)

    @PostMapping("/groups")
    @ResponseStatus(HttpStatus.CREATED)
    fun group(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @Valid @RequestBody input: CreateGroupChatRequest,
    ): ChatResponse =
        chats.createGroup(auth.session(bearer).userId, input)

    @PostMapping("/{id}/members")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun addMembers(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
        @Valid @RequestBody input: AddGroupMembersRequest,
    ) {
        chats.addMembers(id, auth.session(bearer).userId, input)
    }

    @DeleteMapping("/{id}/members/{userId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun removeMember(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable id: String,
        @PathVariable userId: String,
    ) {
        membership.removeMember(id, auth.session(bearer).userId, userId)
    }
}
