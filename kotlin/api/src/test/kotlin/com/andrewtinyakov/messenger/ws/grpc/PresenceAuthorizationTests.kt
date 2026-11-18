package com.andrewtinyakov.messenger.ws.grpc

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.service.DeletionService
import com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import io.grpc.Status
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.OffsetDateTime

class PresenceAuthorizationTests
    @Autowired
    constructor(
        private val authorization: ChatAuthorizationGrpcService,
        private val authentication: AuthenticationService,
        private val chats: ChatService,
        private val memberships: ChatMembershipService,
        private val deletion: DeletionService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `presence returns only requested current members in request order`() {
            val owner = credentials()
            val member = credentials()
            val foreign = credentials()
            val shared = chats.createGroup(
                owner.session.userId,
                "Presence shared",
                listOf(member.session.userId.value).map(::UserId),
            )
            chats.createGroup(
                owner.session.userId,
                "Presence elsewhere",
                listOf(foreign.session.userId.value).map(::UserId),
            )
            val peers = listOf(foreign.session.userId.value, member.session.userId.value, newId(), owner.session.userId.value)
            val reply = call(request(member.session.sessionId.value, shared.id, peers))
            assertNull(reply.error)
            assertTrue(reply.completed)
            assertEquals(listOf(member.session.userId.value, owner.session.userId.value), reply.value?.authorizedUserIdsList)
        }

        @Test
        fun `presence revalidation sees peer removal and requester removal immediately`() {
            val owner = credentials()
            val member = credentials()
            val peer = credentials()
            val chat = chats.createGroup(
                owner.session.userId,
                "Presence removals",
                listOf(member.session.userId.value, peer.session.userId.value).map(::UserId),
            )
            val request = request(member.session.sessionId.value, chat.id, listOf(peer.session.userId.value))
            assertEquals(listOf(peer.session.userId.value), call(request).value?.authorizedUserIdsList)
            memberships.removeMember(ChatId(chat.id), owner.session.userId, peer.session.userId)
            val removedPeer = call(request)
            assertNull(removedPeer.error)
            assertEquals(emptyList<String>(), removedPeer.value?.authorizedUserIdsList)
            memberships.removeMember(ChatId(chat.id), owner.session.userId, member.session.userId)
            assertDenied(request)
        }

        @Test
        fun `presence requires a current session and membership in the requested chat`() {
            val owner = credentials()
            val member = credentials()
            val foreign = credentials()
            val chat = chats.createGroup(
                owner.session.userId,
                "Presence session",
                listOf(member.session.userId.value).map(::UserId),
            )
            assertDenied(request(foreign.session.sessionId.value, chat.id, listOf(owner.session.userId.value)))
            assertDenied(request(member.session.sessionId.value, newId(), listOf(owner.session.userId.value)))
            val request = request(member.session.sessionId.value, chat.id, listOf(owner.session.userId.value))
            db.update(
                "UPDATE sessions SET expires_at=? WHERE token_hash=?",
                OffsetDateTime.now().minusSeconds(1),
                member.session.sessionId.value,
            )
            assertDenied(request)
            val active = request(owner.session.sessionId.value, chat.id, listOf(member.session.userId.value))
            authentication.logout(owner.token)
            assertDenied(active)
            assertDenied(request("0".repeat(64), chat.id, listOf(member.session.userId.value)))
        }

        @Test
        fun `deleted group and direct chats cannot authorize presence`() {
            val owner = credentials()
            val member = credentials()
            val group = chats.createGroup(
                owner.session.userId,
                "Presence deleted",
                listOf(member.session.userId.value).map(::UserId),
            )
            val groupRequest = request(member.session.sessionId.value, group.id, listOf(owner.session.userId.value))
            assertEquals(listOf(owner.session.userId.value), call(groupRequest).value?.authorizedUserIdsList)
            deletion.deleteChat(ChatId(group.id), owner.session.userId, RequestId(group.id), DeletionScope.EVERYONE)
            assertDenied(groupRequest)
            val direct = newId()
            db.update("INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)", direct, "presence_$direct")
            db.update(
                "INSERT INTO chat_members(chat_id,user_id) VALUES (?,?),(?,?)",
                direct,
                owner.session.userId.value,
                direct,
                member.session.userId.value,
            )
            val directRequest = request(member.session.sessionId.value, direct, listOf(owner.session.userId.value))
            assertEquals(listOf(owner.session.userId.value), call(directRequest).value?.authorizedUserIdsList)
            deletion.deleteChat(ChatId(direct), member.session.userId, RequestId(direct), DeletionScope.EVERYONE)
            assertDenied(directRequest)
        }

        @Test
        fun `presence rejects duplicate malformed and excessive target IDs before authorization`() {
            val viewer = credentials()
            val chat = newId()
            val session = viewer.session.sessionId.value
            val invalid = listOf(
                request(session, chat, emptyList()),
                request(session, chat, listOf(viewer.session.userId.value, viewer.session.userId.value)),
                request(session, chat, List(101) { newId() }),
                request(session, chat, listOf("invalid")),
                request(session, "invalid", listOf(newId())),
            )
            for (request in invalid) {
                val reply = call(request)
                assertEquals(Status.Code.INVALID_ARGUMENT, Status.fromThrowable(requireNotNull(reply.error)).code)
                assertNull(reply.value)
                assertTrue(!reply.completed)
            }
            val badSession = call(request("A".repeat(64), chat, listOf(newId())))
            assertEquals(Status.Code.UNAUTHENTICATED, Status.fromThrowable(requireNotNull(badSession.error)).code)
        }

        private fun credentials() = authentication.register("presence_${newId().lowercase()}", "test-password")

        private fun request(session: String, chat: String, users: List<String>): AuthorizePresenceRequest =
            AuthorizePresenceRequest.newBuilder().setSessionId(session).setChatId(chat).addAllUserIds(users).build()

        private fun assertDenied(request: AuthorizePresenceRequest) {
            val reply = call(request)
            assertNotNull(reply.error)
            assertEquals(Status.Code.PERMISSION_DENIED, Status.fromThrowable(requireNotNull(reply.error)).code)
            assertNull(reply.value)
            assertTrue(!reply.completed)
        }

        private fun call(request: AuthorizePresenceRequest): PresenceReply = PresenceReply().also {
            authorization.authorizePresence(request, it)
        }
    }
