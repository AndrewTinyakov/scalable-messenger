package com.andrewtinyakov.messenger.ws.grpc

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SEND_REQUESTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.ws.repository.SidebarAuthorizationRepository
import org.jooq.impl.DSL
import org.jooq.types.DayToSecond
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.Duration
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
            val direct = db.fetchValue(
                SEND_REQUESTS.CHAT_ID,
                SEND_REQUESTS.SENDER_ID.eq(owner).and(SEND_REQUESTS.REQUEST_ID.eq(request)),
            )!!
            val session = SessionId("a".repeat(64))
            insertSession(session, owner, "sidebar")
            val ids = listOf(group.id, direct, foreign.id, newId()).map(::ChatId)
            val granted = repository.authorize(session, ids, OffsetDateTime.now())!!
            assertEquals(setOf(ChatId(group.id), ChatId(direct)), granted.map { it.chatId }.toSet())
            assertEquals(UserId(peer), granted.single { it.chatId == ChatId(direct) }.peerId)
            assertNull(granted.single { it.group }.peerId)
            memberships.removeMember(ChatId(group.id), UserId(owner), UserId(peer))
            val peerSession = SessionId("b".repeat(64))
            insertSession(peerSession, peer, "sidebar-peer")
            assertTrue(repository.authorize(peerSession, listOf(ChatId(group.id)), OffsetDateTime.now())!!.isEmpty())
            db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE, 1L)
                .where(CHAT_MEMBERS.CHAT_ID.eq(direct), CHAT_MEMBERS.USER_ID.eq(owner)).execute()
            assertTrue(repository.authorize(session, listOf(ChatId(direct)), OffsetDateTime.now())!!.isEmpty())
            db.update(CHATS).set(CHATS.DELETED_AT, DSL.currentOffsetDateTime()).where(CHATS.ID.eq(group.id)).execute()
            assertTrue(repository.authorize(session, listOf(ChatId(group.id)), OffsetDateTime.now())!!.isEmpty())
            db.update(
                SESSIONS,
            ).set(SESSIONS.EXPIRES_AT, DSL.currentOffsetDateTime().sub(DSL.inline(DayToSecond.valueOf(Duration.ofMinutes(1)))))
                .where(SESSIONS.TOKEN_HASH.eq(session.value)).execute()
            assertNull(repository.authorize(session, ids, OffsetDateTime.now()))
        }

        private fun insertSession(session: SessionId, user: String, device: String) {
            db.insertInto(SESSIONS)
                .set(SESSIONS.TOKEN_HASH, session.value)
                .set(SESSIONS.USER_ID, user)
                .set(SESSIONS.DEVICE_ID, device)
                .set(SESSIONS.EXPIRES_AT, DSL.currentOffsetDateTime().add(DSL.inline(DayToSecond.valueOf(Duration.ofHours(1)))))
                .execute()
        }
    }
