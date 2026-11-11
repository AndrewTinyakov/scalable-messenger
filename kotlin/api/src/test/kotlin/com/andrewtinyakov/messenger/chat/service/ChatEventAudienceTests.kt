package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.lang.reflect.Proxy

class ChatEventAudienceTests {
    private val chat = ChatId(newId())
    private val actor = UserId(newId())
    private val peer = UserId(newId())
    private val lookups = mutableListOf<ChatId>()
    private val audience = ChatEventAudience(
        object : ChatRepository by unsupportedRepository() {
            override fun findMemberIds(chatId: ChatId): List<UserId> {
                lookups += chatId
                return listOf(actor, peer)
            }
        },
    )

    @Test
    fun `personal change reaches only the viewer's user room`() {
        for (kind in ChatKind.entries) {
            assertEquals(listOf("user:${actor.value}"), audience.rooms(chat, kind, personalViewer = actor))
        }
        assertEquals(emptyList<ChatId>(), lookups)
    }

    @Test
    fun `group change reaches the group room without loading members`() {
        assertEquals(listOf("group:${chat.value}"), audience.rooms(chat, ChatKind.GROUP))
        assertEquals(emptyList<ChatId>(), lookups)
    }

    @Test
    fun `direct change reaches each member's user room`() {
        assertEquals(listOf("user:${actor.value}", "user:${peer.value}"), audience.rooms(chat, ChatKind.DIRECT))
        assertEquals(listOf(chat), lookups)
    }

    private fun unsupportedRepository(): ChatRepository =
        Proxy.newProxyInstance(ChatRepository::class.java.classLoader, arrayOf(ChatRepository::class.java)) { _, method, _ ->
            throw UnsupportedOperationException(method.name)
        } as ChatRepository
}
