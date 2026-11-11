package com.andrewtinyakov.messenger.chat.grpc

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.chat.grpc.config.GrpcProperties
import com.andrewtinyakov.messenger.chat.grpc.config.GrpcServerLifecycle
import com.andrewtinyakov.messenger.chat.grpc.service.ChatAuthorizationGrpcService
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest
import com.andrewtinyakov.messenger.generated.grpc.ChatAuthorizationGrpc
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import io.grpc.Status
import io.grpc.StatusRuntimeException
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.io.File
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.TimeUnit

class GrpcTransportTests : MessengerIntegrationTest() {
    @Autowired
    private lateinit var chatAuthorizationGrpcService: ChatAuthorizationGrpcService

    @Autowired
    private lateinit var authenticationService: AuthenticationService

    @Autowired
    private lateinit var chatService: ChatService

    @Autowired
    private lateinit var chatMembershipService: ChatMembershipService

    private lateinit var server: GrpcServerLifecycle

    @BeforeAll
    fun startServer() {
        server = GrpcServerLifecycle(
            chatAuthorizationGrpcService = chatAuthorizationGrpcService,
            properties = GrpcProperties(
                port = 0,
                bindAddress = "127.0.0.1",
                caFile = fixture("ca.pem").path,
                certFile = fixture("api-cert.pem").path,
                keyFile = fixture("api-key.pem").path,
                allowedClientIdentity = "spiffe://messenger/ws",
            ),
        )
        server.start()
    }

    @AfterAll
    fun stopServer() {
        server.stop()
    }

    @Test
    fun `trusted WS certificate resolves persisted session identity over TLS`() {
        val credentials = authenticationService.register(
            AuthRequest("tls_${UUID.randomUUID().toString().replace("-", "").take(20)}", "test-password", "tls-device"),
        )

        withClient { client ->
            val response = client.validateSession(
                ValidateSessionRequest.newBuilder().setSessionId(credentials.session.sessionId.value).build(),
            )
            assertEquals(credentials.session.userId.value, response.userId)
            assertEquals("tls-device", response.deviceId)
            assertEquals(credentials.session.sessionId.value, response.sessionId)
        }
    }

    @Test
    fun `client certificate is required by TLS`() {
        withClient(identity = null) { client ->
            assertRpcStatus(Status.Code.UNAVAILABLE) { client.validateSession(unknownSession()) }
        }
    }

    @Test
    fun `client certificate must chain to the configured CA`() {
        withClient(identity = "untrusted") { client ->
            assertRpcStatus(Status.Code.UNAVAILABLE) { client.validateSession(unknownSession()) }
        }
    }

    @Test
    fun `trusted client certificate must contain the allowed URI identity`() {
        withClient(identity = "disallowed") { client ->
            assertRpcStatus(Status.Code.PERMISSION_DENIED) { client.validateSession(unknownSession()) }
            assertRpcStatus(Status.Code.PERMISSION_DENIED) {
                client.authorizeGroup(AuthorizeGroupRequest.newBuilder().setSessionId("0".repeat(64)).setChatId("invalid").build())
            }
            assertRpcStatus(Status.Code.PERMISSION_DENIED) {
                client.authorizeGroups(AuthorizeGroupsRequest.newBuilder().setSessionId("0".repeat(64)).build())
            }
        }
    }

    @Test
    fun `client rejects a server outside its trusted CA`() {
        withClient(ca = "other-ca.pem") { client ->
            assertRpcStatus(Status.Code.UNAVAILABLE) { client.validateSession(unknownSession()) }
        }
    }

    @Test
    fun `client rejects a server with a different DNS identity`() {
        withClient(authority = "wrong-api-grpc") { client ->
            assertRpcStatus(Status.Code.UNAVAILABLE) { client.validateSession(unknownSession()) }
        }
    }

    @Test
    fun `RPCs require a lowercase hex session ID and a live persisted session`() {
        val credentials = authenticationService.register(
            AuthRequest("sid_${UUID.randomUUID().toString().replace("-", "").take(20)}", "test-password"),
        )
        val request = ValidateSessionRequest.newBuilder().setSessionId(credentials.session.sessionId.value).build()
        withClient { client ->
            for (invalid in listOf("", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), credentials.token.value)) {
                assertRpcStatus(Status.Code.UNAUTHENTICATED) { client.validateSession(request.toBuilder().setSessionId(invalid).build()) }
            }
            assertRpcStatus(Status.Code.UNAUTHENTICATED) { client.validateSession(unknownSession()) }
            authenticationService.logout(credentials.token)
            assertRpcStatus(Status.Code.UNAUTHENTICATED) { client.validateSession(request) }
            assertRpcStatus(Status.Code.UNAUTHENTICATED) {
                client.authorizeGroup(
                    AuthorizeGroupRequest.newBuilder().setSessionId(credentials.session.sessionId.value).setChatId(newId()).build(),
                )
            }
            assertRpcStatus(Status.Code.UNAUTHENTICATED) {
                client.authorizeGroups(
                    AuthorizeGroupsRequest.newBuilder().setSessionId(credentials.session.sessionId.value).addChatIds(newId()).build(),
                )
            }
        }
    }

    @Test
    fun `RPCs reject sessions expired in SQL`() {
        val credentials = authenticationService.register(
            AuthRequest("exp_${UUID.randomUUID().toString().replace("-", "").take(20)}", "test-password"),
        )
        db.update(
            "UPDATE sessions SET expires_at=? WHERE token_hash=?",
            OffsetDateTime.now().minusSeconds(1),
            credentials.session.sessionId.value,
        )
        withClient { client ->
            assertRpcStatus(Status.Code.UNAUTHENTICATED) {
                client.validateSession(ValidateSessionRequest.newBuilder().setSessionId(credentials.session.sessionId.value).build())
            }
            assertRpcStatus(Status.Code.UNAUTHENTICATED) {
                client.authorizeGroup(
                    AuthorizeGroupRequest.newBuilder().setSessionId(credentials.session.sessionId.value).setChatId(newId()).build(),
                )
            }
            assertRpcStatus(Status.Code.UNAUTHENTICATED) {
                client.authorizeGroups(
                    AuthorizeGroupsRequest.newBuilder().setSessionId(credentials.session.sessionId.value).addChatIds(newId()).build(),
                )
            }
        }
    }

    @Test
    fun `group RPCs consult current memberships and retain argument validation`() {
        val suffix = UUID.randomUUID().toString().replace("-", "").take(12)
        val owner = authenticationService.register(AuthRequest("owner_$suffix", "test-password"))
        val member = authenticationService.register(AuthRequest("member_$suffix", "test-password"))
        val other = authenticationService.register(AuthRequest("other_$suffix", "test-password"))
        val joined = chatService.createGroup(owner.session.userId, "Joined", listOf(member.session.userId.value).map(::UserId))
        val unjoined = chatService.createGroup(owner.session.userId, "Unjoined", listOf(other.session.userId.value).map(::UserId))
        val single = AuthorizeGroupRequest.newBuilder().setSessionId(member.session.sessionId.value).setChatId(joined.id).build()
        val batch = AuthorizeGroupsRequest.newBuilder().setSessionId(
            member.session.sessionId.value,
        ).addChatIds(joined.id).addChatIds(unjoined.id).build()
        withClient { client ->
            assertEquals("group:${joined.id}", client.authorizeGroup(single).room)
            assertEquals(listOf(joined.id), client.authorizeGroups(batch).authorizedChatIdsList)
            assertRpcStatus(Status.Code.PERMISSION_DENIED) { client.authorizeGroup(single.toBuilder().setChatId(unjoined.id).build()) }
            assertRpcStatus(Status.Code.INVALID_ARGUMENT) { client.authorizeGroup(single.toBuilder().setChatId("invalid").build()) }
            assertRpcStatus(Status.Code.INVALID_ARGUMENT) { client.authorizeGroups(batch.toBuilder().clearChatIds().build()) }
            assertRpcStatus(Status.Code.INVALID_ARGUMENT) { client.authorizeGroups(batch.toBuilder().addChatIds(joined.id).build()) }
            assertRpcStatus(Status.Code.INVALID_ARGUMENT) {
                client.authorizeGroups(batch.toBuilder().clearChatIds().addChatIds("invalid").build())
            }
            assertRpcStatus(Status.Code.INVALID_ARGUMENT) {
                client.authorizeGroups(batch.toBuilder().clearChatIds().addAllChatIds(List(11) { newId() }).build())
            }
            chatMembershipService.removeMember(ChatId(joined.id), owner.session.userId, member.session.userId)
            assertRpcStatus(Status.Code.PERMISSION_DENIED) { client.authorizeGroup(single) }
            assertEquals(emptyList<String>(), client.authorizeGroups(batch).authorizedChatIdsList)
            chatService.addMembers(
                chatId = ChatId(unjoined.id),
                userId = owner.session.userId,
                memberIds = listOf(member.session.userId.value).map(::UserId),
            )
            assertEquals("group:${unjoined.id}", client.authorizeGroup(single.toBuilder().setChatId(unjoined.id).build()).room)
            assertEquals(listOf(unjoined.id), client.authorizeGroups(batch).authorizedChatIdsList)
        }
    }

    @Test
    fun `group authorization rejects direct chats even when the session user is a member`() {
        val credentials = authenticationService.register(
            AuthRequest(username = "direct_${newId().lowercase()}", password = "test-password"),
        )
        val chatId = newId()
        db.update("INSERT INTO chats(id,kind,direct_pair_key) VALUES (?,'DIRECT',?)", chatId, "pair_$chatId")
        db.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?)", chatId, credentials.session.userId.value)
        withClient { client ->
            assertRpcStatus(Status.Code.PERMISSION_DENIED) {
                client.authorizeGroup(
                    AuthorizeGroupRequest.newBuilder().setSessionId(credentials.session.sessionId.value).setChatId(chatId).build(),
                )
            }
            assertEquals(
                emptyList<String>(),
                client.authorizeGroups(
                    AuthorizeGroupsRequest.newBuilder().setSessionId(credentials.session.sessionId.value).addChatIds(chatId).build(),
                ).authorizedChatIdsList,
            )
        }
    }

    private fun unknownSession(): ValidateSessionRequest = ValidateSessionRequest.newBuilder().setSessionId("0".repeat(64)).build()

    private fun assertRpcStatus(expected: Status.Code, action: () -> Unit) {
        assertEquals(expected, assertThrows(StatusRuntimeException::class.java, action).status.code)
    }

    private fun <T> withClient(
        identity: String? = "ws",
        ca: String = "ca.pem",
        authority: String = "api-grpc",
        action: (ChatAuthorizationGrpc.ChatAuthorizationBlockingStub) -> T,
    ): T {
        val tls = GrpcSslContexts.forClient().trustManager(fixture(ca))
        if (identity != null) tls.keyManager(fixture("$identity-cert.pem"), fixture("$identity-key.pem"))
        val channel = NettyChannelBuilder.forAddress("127.0.0.1", server.boundPort)
            .overrideAuthority(authority)
            .sslContext(tls.build())
            .build()
        try {
            return action(ChatAuthorizationGrpc.newBlockingStub(channel).withDeadlineAfter(5, TimeUnit.SECONDS))
        } finally {
            channel.shutdownNow()
            assertTrue(channel.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    private fun fixture(name: String): File = File(requireNotNull(javaClass.getResource("/grpc-tls/$name")).toURI())
}
