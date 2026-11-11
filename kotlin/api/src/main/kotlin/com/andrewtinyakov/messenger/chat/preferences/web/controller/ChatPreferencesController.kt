package com.andrewtinyakov.messenger.chat.preferences.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.preferences.service.ChatPreferencesService
import com.andrewtinyakov.messenger.chat.preferences.web.payload.ChatPreferencesResponse
import com.andrewtinyakov.messenger.chat.preferences.web.payload.MuteChatRequest
import com.andrewtinyakov.messenger.chat.preferences.web.payload.PinnedChatsResponse
import com.andrewtinyakov.messenger.chat.preferences.web.payload.ReorderPinnedChatsRequest
import jakarta.validation.Valid
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/chats")
class ChatPreferencesController(
    private val service: ChatPreferencesService,
) {
    @PutMapping("/pinned")
    fun reorder(
        session: AuthenticatedSession,
        @Valid @RequestBody input: ReorderPinnedChatsRequest,
    ): PinnedChatsResponse = service.reorder(session.userId, input.chatIds.map { ChatId.parse(it) })

    @PutMapping("/{id}/pin")
    fun pin(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): PinnedChatsResponse = service.pin(ChatId.parse(id), session.userId)

    @DeleteMapping("/{id}/pin")
    fun unpin(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): PinnedChatsResponse = service.unpin(ChatId.parse(id), session.userId)

    @PutMapping("/{id}/mute")
    fun mute(
        session: AuthenticatedSession,
        @PathVariable id: String,
        @RequestBody input: MuteChatRequest,
    ): ChatPreferencesResponse = service.mute(ChatId.parse(id), session.userId, input.durationSeconds)

    @DeleteMapping("/{id}/mute")
    fun unmute(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): ChatPreferencesResponse = service.unmute(ChatId.parse(id), session.userId)

    @PutMapping("/{id}/unread-mark")
    fun markUnread(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): ChatPreferencesResponse = service.markUnread(ChatId.parse(id), session.userId, unread = true)

    @DeleteMapping("/{id}/unread-mark")
    fun clearUnreadMark(
        session: AuthenticatedSession,
        @PathVariable id: String,
    ): ChatPreferencesResponse = service.markUnread(ChatId.parse(id), session.userId, unread = false)
}
