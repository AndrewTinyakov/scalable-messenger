package com.andrewtinyakov.messenger.chat.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.web.AUTHENTICATED_SESSION_ATTRIBUTE
import com.andrewtinyakov.messenger.chat.service.ChatDeletionService
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.service.DirectChatLookupService
import com.andrewtinyakov.messenger.chat.web.payload.AddGroupMembersRequest
import com.andrewtinyakov.messenger.chat.web.payload.ChatPageResponse
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.chat.web.payload.DirectChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.GroupMemberPageResponse
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.requireId
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats")
class ChatController(
    private val chatService: ChatService,
    private val chatDeletionService: ChatDeletionService,
    private val chatMembershipService: ChatMembershipService,
    private val directChatLookupService: DirectChatLookupService,
) {
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
    ) {
        chatDeletionService.delete(ChatId(requireId(id)), session.userId)
    }

    @GetMapping
    fun list(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @RequestParam(required = false) cursor: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): ChatPageResponse =
        chatService.list(userId = session.userId, cursor = cursor, limit = limit)

    @GetMapping("/direct/{userId}")
    fun direct(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable userId: String,
    ): DirectChatResponse = directChatLookupService.get(userId = session.userId, recipientId = UserId(requireId(userId)))

    @GetMapping("/{id}")
    fun get(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
    ): ChatResponse = chatService.get(chatId = ChatId(requireId(id)), userId = session.userId)

    @PostMapping("/groups")
    @ResponseStatus(HttpStatus.CREATED)
    fun group(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @Valid @RequestBody input: CreateGroupChatRequest,
    ): ChatResponse =
        chatService.createGroup(userId = session.userId, input = input)

    @GetMapping("/{id}/members")
    fun members(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam(required = false) afterUserId: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): GroupMemberPageResponse =
        chatMembershipService.listMembers(
            chatId = ChatId(requireId(id)),
            viewerId = session.userId,
            afterUserId = afterUserId?.let { UserId(requireId(it)) },
            limit = limit,
        )

    @PostMapping("/{id}/members")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun addMembers(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @Valid @RequestBody input: AddGroupMembersRequest,
    ) {
        chatService.addMembers(chatId = ChatId(requireId(id)), actorId = session.userId, input = input)
    }

    @DeleteMapping("/{id}/members/{userId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun removeMember(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable userId: String,
    ) {
        chatMembershipService.removeMember(chatId = ChatId(requireId(id)), actorId = session.userId, memberId = UserId(requireId(userId)))
    }
}
