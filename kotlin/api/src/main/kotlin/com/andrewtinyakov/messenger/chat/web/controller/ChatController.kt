package com.andrewtinyakov.messenger.chat.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.service.DirectChatLookupService
import com.andrewtinyakov.messenger.chat.web.payload.AddGroupMembersRequest
import com.andrewtinyakov.messenger.chat.web.payload.ChatPageResponse
import com.andrewtinyakov.messenger.chat.web.payload.ChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.chat.web.payload.DirectChatResponse
import com.andrewtinyakov.messenger.chat.web.payload.GroupMemberPageResponse
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.service.DeletionService
import com.andrewtinyakov.messenger.message.model.RequestId
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats")
class ChatController(
    private val chatService: ChatService,
    private val deletionService: DeletionService,
    private val chatMembershipService: ChatMembershipService,
    private val directChatLookupService: DirectChatLookupService,
) {
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ) {
        val chatId = ChatId.parse(id)
        deletionService.deleteChat(
            chatId = chatId,
            userId = session.userId,
            requestId = RequestId(chatId.value),
            scope = DeletionScope.EVERYONE,
        )
    }

    @GetMapping
    fun list(
        session: AuthenticatedSession,
        @RequestParam(required = false) cursor: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): ChatPageResponse =
        chatService.list(userId = session.userId, cursor = cursor, limit = limit)

    @GetMapping("/direct/{userId}")
    fun direct(
        session: AuthenticatedSession,
        @PathVariable userId: String,
    ): DirectChatResponse = directChatLookupService.get(userId = session.userId, recipientId = UserId.parse(userId))

    @GetMapping("/{id}")
    fun get(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): ChatResponse = chatService.get(chatId = ChatId.parse(id), userId = session.userId)

    @PostMapping("/groups")
    @ResponseStatus(HttpStatus.CREATED)
    fun group(
        session: AuthenticatedSession,
        @Valid @RequestBody input: CreateGroupChatRequest,
    ): ChatResponse =
        chatService.createGroup(userId = session.userId, name = input.name, memberIds = input.memberIds.map(UserId::parse))

    @GetMapping("/{id}/members")
    fun members(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestParam(required = false) afterUserId: String?,
        @RequestParam(defaultValue = "50") limit: Int,
    ): GroupMemberPageResponse =
        chatMembershipService.listMembers(
            chatId = ChatId.parse(id),
            viewerId = session.userId,
            afterUserId = afterUserId?.let { UserId.parse(it) },
            limit = limit,
        )

    @PostMapping("/{id}/members")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun addMembers(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @Valid @RequestBody input: AddGroupMembersRequest,
    ) {
        chatService.addMembers(chatId = ChatId.parse(id), userId = session.userId, memberIds = input.memberIds.map(UserId::parse))
    }

    @DeleteMapping("/{id}/members/{userId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun removeMember(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @PathVariable userId: String,
    ) {
        chatMembershipService.removeMember(chatId = ChatId.parse(id), userId = session.userId, memberId = UserId.parse(userId))
    }
}
