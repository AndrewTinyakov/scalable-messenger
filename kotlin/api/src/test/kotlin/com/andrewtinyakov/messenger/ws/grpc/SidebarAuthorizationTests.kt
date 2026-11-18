package com.andrewtinyakov.messenger.ws.grpc

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.ws.repository.SidebarAuthorizationRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.OffsetDateTime

class SidebarAuthorizationTests
    @Autowired
    constructor(
        private val repository: SidebarAuthorizationRepository,
        private val chats: ChatService,
        private val sends: MessageSendService,
        private val memberships: ChatMembershipService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `sidebar batches current memberships and derives only direct peers`() {
            val owner = user("sidebar-owner")
            val peer = user("sidebar-peer")
            val stranger = user("sidebar-stranger")
            val group = chats.createGroup(UserId(owner), "Sidebar", listOf(peer).map(::UserId))
            val foreign = chats.createGroup(UserId(stranger), "Foreign", listOf(peer).map(::UserId))
            val request = newId()
            sends.process(command(owner, request, "Direct", recipient = peer))
            val direct = db.queryForObject(
                "SELECT chat_id FROM send_requests WHERE sender_id=? AND request_id=?",
                String::class.java,
                owner,
                request,
            )!!
            val session = SessionId("a".repeat(64))
            db.update(
                "INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES (?,?,'sidebar',now()+interval '1 hour')",
                session.value,
                owner,
            )
            val ids = listOf(group.id, direct, foreign.id, newId()).map(::ChatId)
            val granted = repository.authorize(session, ids, OffsetDateTime.now())!!
            assertEquals(setOf(ChatId(group.id), ChatId(direct)), granted.map { it.chatId }.toSet())
            assertEquals(UserId(peer), granted.single { it.chatId == ChatId(direct) }.peerId)
            assertNull(granted.single { it.group }.peerId)
            memberships.removeMember(ChatId(group.id), UserId(owner), UserId(peer))
            val peerSession = SessionId("b".repeat(64))
            db.update(
                "INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES (?,?,'sidebar-peer',now()+interval '1 hour')",
                peerSession.value,
                peer,
            )
            assertTrue(repository.authorize(peerSession, listOf(ChatId(group.id)), OffsetDateTime.now())!!.isEmpty())
            db.update("UPDATE chat_members SET hidden_through_sequence=1 WHERE chat_id=? AND user_id=?", direct, owner)
            assertTrue(repository.authorize(session, listOf(ChatId(direct)), OffsetDateTime.now())!!.isEmpty())
            db.update("UPDATE chats SET deleted_at=now() WHERE id=?", group.id)
            assertTrue(repository.authorize(session, listOf(ChatId(group.id)), OffsetDateTime.now())!!.isEmpty())
            db.update("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=?", session.value)
            assertNull(repository.authorize(session, ids, OffsetDateTime.now()))
        }
    }
