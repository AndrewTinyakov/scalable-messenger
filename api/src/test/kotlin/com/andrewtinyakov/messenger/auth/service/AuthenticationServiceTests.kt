package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.chat.grpc.ChatAuthorizationGrpcService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse
import com.andrewtinyakov.messenger.shared.web.ApiException
import io.grpc.Status
import io.grpc.StatusRuntimeException
import io.grpc.stub.StreamObserver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import tools.jackson.databind.ObjectMapper
import java.util.UUID

@SpringBootTest(
    classes = [ApiApplication::class],
    properties = ["spring.rabbitmq.dynamic=false", "spring.rabbitmq.listener.simple.auto-startup=false"],
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AuthenticationServiceTests
    @Autowired
    constructor(
        private val auth: AuthenticationService,
        private val tickets: WsTicketService,
        private val grpc: ChatAuthorizationGrpcService,
        private val chats: ChatService,
        private val db: JdbcTemplate,
        private val mapper: ObjectMapper,
    ) {
        companion object {
            private val postgres = PostgreSQLContainer<Nothing>("postgres:17-alpine").apply {
                withDatabaseName("messenger")
                withUsername("messenger")
                withPassword("messenger")
                start()
            }

            @JvmStatic
            @DynamicPropertySource
            fun properties(registry: DynamicPropertyRegistry) {
                registry.add("spring.datasource.url", postgres::getJdbcUrl)
                registry.add("spring.datasource.username", postgres::getUsername)
                registry.add("spring.datasource.password", postgres::getPassword)
            }
        }

        @Test
        fun `logout revokes only the bearer session and publishes one exact event`() {
            val username = "logout_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val first = auth.register(AuthRequest(username, "long-demo-password", "first-device"))
            val second = auth.login(AuthRequest(username, "long-demo-password", "second-device"))
            val firstBearer = "Bearer ${first.token}"
            val secondBearer = "Bearer ${second.token}"
            val firstSession = auth.authenticatedSession(firstBearer)
            val secondSession = auth.authenticatedSession(secondBearer)
            val ticket = tickets.issue(firstSession).token
            val validation = ValidateSessionRequest.newBuilder().setWsTicket(ticket).build()

            assertEquals(firstSession.sessionId, validate(validation).sessionId)
            assertTrue(auth.activeTicketSession(firstSession.sessionId, first.user.id, first.deviceId))

            auth.logout(firstBearer)
            auth.logout(firstBearer)

            assertFalse(auth.activeTicketSession(firstSession.sessionId, first.user.id, first.deviceId))
            assertTrue(auth.activeTicketSession(secondSession.sessionId, second.user.id, second.deviceId))
            assertThrows(ApiException::class.java) { auth.session(firstBearer) }
            assertEquals(second.user.id, auth.session(secondBearer).userId)
            assertEquals(Status.Code.UNAUTHENTICATED, validateError(validation).status.code)

            val payload = db.queryForObject(
                "SELECT payload::text FROM messenger_outbox_events WHERE room=? AND payload->>'type'='session_revoked'",
                String::class.java,
                "user:${first.user.id}",
            )!!
            val event = mapper.readTree(payload)
            assertEquals(5, event.size())
            assertEquals("session_revoked", event.path("type").asText())
            assertEquals(1, event.path("version").asInt())
            assertEquals(firstSession.sessionId, event.path("sessionId").asText())
            assertNotNull(event.path("eventId").asText())
        }

        @Test
        fun `batch group authorization returns only current memberships and checks session`() {
            val suffix = UUID.randomUUID().toString().replace("-", "").take(12)
            val owner = auth.register(AuthRequest("owner_$suffix", "long-demo-password", "owner-device"))
            val member = auth.register(AuthRequest("member_$suffix", "long-demo-password", "member-device"))
            val other = auth.register(AuthRequest("other_$suffix", "long-demo-password", "other-device"))
            val joined = chats.createGroup(owner.user.id, CreateGroupChatRequest("Joined", listOf(member.user.id)))
            val unjoined = chats.createGroup(owner.user.id, CreateGroupChatRequest("Unjoined", listOf(other.user.id)))
            val bearer = "Bearer ${member.token}"
            val ticket = tickets.issue(auth.authenticatedSession(bearer)).token
            val request = AuthorizeGroupsRequest.newBuilder().setWsTicket(ticket)
                .addChatIds(joined.id).addChatIds(unjoined.id).build()

            assertEquals(listOf(joined.id), authorizeGroups(request).authorizedChatIdsList)
            auth.logout(bearer)
            val rejected = assertThrows(StatusRuntimeException::class.java) { authorizeGroups(request) }
            assertEquals(Status.Code.UNAUTHENTICATED, rejected.status.code)
        }

        private fun authorizeGroups(request: AuthorizeGroupsRequest): AuthorizeGroupsResponse {
            var value: AuthorizeGroupsResponse? = null
            var error: Throwable? = null
            grpc.authorizeGroups(
                request,
                object : StreamObserver<AuthorizeGroupsResponse> {
                    override fun onNext(response: AuthorizeGroupsResponse) {
                        value = response
                    }

                    override fun onError(cause: Throwable) {
                        error = cause
                    }

                    override fun onCompleted() {}
                },
            )
            error?.let { throw it }
            return requireNotNull(value)
        }

        private fun validate(request: ValidateSessionRequest): ValidateSessionResponse {
            var value: ValidateSessionResponse? = null
            var error: Throwable? = null
            grpc.validateSession(
                request,
                object : StreamObserver<ValidateSessionResponse> {
                    override fun onNext(response: ValidateSessionResponse) {
                        value = response
                    }

                    override fun onError(cause: Throwable) {
                        error = cause
                    }

                    override fun onCompleted() {}
                },
            )
            error?.let { throw it }
            return requireNotNull(value)
        }

        private fun validateError(request: ValidateSessionRequest): StatusRuntimeException =
            assertThrows(StatusRuntimeException::class.java) { validate(request) }
    }
