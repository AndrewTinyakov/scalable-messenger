package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.auth.model.ExpectedSessionIdentity
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.ws.grpc.ChatAuthorizationGrpcService
import com.andrewtinyakov.messenger.ws.service.WsTicketService
import io.grpc.Status
import io.grpc.StatusRuntimeException
import io.grpc.stub.StreamObserver
import org.jooq.DSLContext
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.impl.DSL
import org.jooq.impl.DefaultExecuteListenerProvider
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import tools.jackson.databind.ObjectMapper
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@SpringBootTest(
    classes = [ApiApplication::class],
    properties = ["spring.rabbitmq.dynamic=false", "spring.rabbitmq.listener.simple.auto-startup=false", "messenger.grpc.enabled=false"],
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AuthenticationServiceTests
    @Autowired
    constructor(
        private val authenticationService: AuthenticationService,
        private val wsTicketService: WsTicketService,
        private val chatAuthorizationGrpcService: ChatAuthorizationGrpcService,
        private val chatService: ChatService,
        private val mapper: ObjectMapper,
        private val db: DSLContext,
    ) {
        companion object {
            private val postgres = PostgreSQLContainer<Nothing>("postgres:19-alpine").apply {
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
        fun `registration and login return credentials for their persisted session`() {
            val username = "identity_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val registered = authenticationService.register(username, "long-demo-password", "identity-device")
            val loggedIn = authenticationService.login(username, "long-demo-password", "identity-device")

            for (credentials in listOf(registered, loggedIn)) {
                val stored = authenticationService.authenticatedSession(credentials.token)
                assertEquals(sha256(credentials.token.value), credentials.session.sessionId.value)
                assertEquals(stored.userId, credentials.session.userId)
                assertEquals(username, credentials.user.username)
                assertEquals("identity-device", credentials.session.deviceId.value)
                assertEquals(stored.sessionId, credentials.session.sessionId)
                assertEquals(stored.expiresAt.epochSecond, credentials.session.expiresAt.epochSecond)
            }
            assertEquals(registered.session.userId, loggedIn.session.userId)
        }

        @Test
        fun `websocket ticket expires no later than its cookie session`() {
            val username = "expiry_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val created = authenticationService.register(username, "long-demo-password")
            val bearer = created.token
            val session = authenticationService.authenticatedSession(bearer)
            val expiry = OffsetDateTime.now(ZoneOffset.UTC).plusMinutes(5).withNano(0)
            db.update(SESSIONS).set(SESSIONS.EXPIRES_AT, expiry).where(SESSIONS.TOKEN_HASH.eq(session.sessionId.value)).execute()

            val issued = wsTicketService.issue(authenticationService.authenticatedSession(bearer))

            assertEquals(expiry.toEpochSecond(), issued.expiresAt.epochSecond)
            val claims = mapper.readTree(java.util.Base64.getUrlDecoder().decode(issued.token.split('.')[1]))
            assertEquals(expiry.toEpochSecond(), claims.path("exp").longValue())
        }

        @Test
        fun `registration preserves password differences past seventy two bytes`() {
            val username = "password_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val prefix = "é".repeat(40)
            val created = authenticationService.register(username, "${prefix}correct")

            assertEquals(created.session.userId, authenticationService.login(username, "${prefix}correct").session.userId)
            assertThrows(ApiException::class.java) { authenticationService.login(username, "${prefix}incorrect") }
        }

        @Test
        fun `login accepts existing untagged bcrypt passwords`() {
            val username = "legacy_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val userId = newId()
            val hash = BCryptPasswordEncoder().encode("legacy-password")
            db.insertInto(USERS, USERS.ID, USERS.USERNAME, USERS.PASSWORD_HASH).values(userId, username, hash).execute()

            assertEquals(userId, authenticationService.login(username, "legacy-password").session.userId.value)
            assertThrows(ApiException::class.java) { authenticationService.login(username, "incorrect-password") }
        }

        @Test
        fun `logout revokes only the cookie session and publishes one exact event`() {
            val username = "logout_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val first = authenticationService.register(username, "long-demo-password", "first-device")
            val second = authenticationService.login(username, "long-demo-password", "second-device")
            val firstBearer = first.token
            val secondBearer = second.token
            val firstSession = authenticationService.authenticatedSession(firstBearer)
            val secondSession = authenticationService.authenticatedSession(secondBearer)
            val validation = ValidateSessionRequest.newBuilder().setSessionId(firstSession.sessionId.value).build()

            assertEquals(firstSession.sessionId.value, validate(validation).sessionId)

            authenticationService.logout(firstBearer)
            authenticationService.logout(firstBearer)

            assertEquals(
                secondSession.sessionId.value,
                validate(ValidateSessionRequest.newBuilder().setSessionId(secondSession.sessionId.value).build()).sessionId,
            )
            assertThrows(ApiException::class.java) { authenticationService.authenticatedSession(firstBearer) }
            assertEquals(second.session.userId, authenticationService.authenticatedSession(secondBearer).userId)
            assertEquals(Status.Code.UNAUTHENTICATED, validateError(validation).status.code)

            val payload = db.select(MESSENGER_OUTBOX_EVENTS.PAYLOAD).from(MESSENGER_OUTBOX_EVENTS)
                .where(
                    MESSENGER_OUTBOX_EVENTS.ROOM.eq("user:${first.session.userId.value}"),
                    DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq("session_revoked"),
                ).fetchSingle().value1().data()
            val event = mapper.readTree(payload)
            assertEquals(5, event.size())
            assertEquals("session_revoked", event.path("type").stringValue())
            assertEquals(1, event.path("version").intValue())
            assertEquals(firstSession.sessionId.value, event.path("sessionId").stringValue())
            assertNotNull(event.path("eventId").stringValue())
        }

        @Test
        fun `batch group authorization returns only current memberships and checks session`() {
            val suffix = UUID.randomUUID().toString().replace("-", "").take(12)
            val owner = authenticationService.register("owner_$suffix", "long-demo-password", "owner-device")
            val member = authenticationService.register("member_$suffix", "long-demo-password", "member-device")
            val other = authenticationService.register("other_$suffix", "long-demo-password", "other-device")
            val joined = chatService.createGroup(
                owner.session.userId,
                "Joined",
                listOf(member.session.userId.value).map(::UserId),
            )
            val unjoined = chatService.createGroup(
                owner.session.userId,
                "Unjoined",
                listOf(other.session.userId.value).map(::UserId),
            )
            val bearer = member.token
            val request = AuthorizeGroupsRequest.newBuilder().setSessionId(member.session.sessionId.value)
                .addChatIds(joined.id).addChatIds(unjoined.id).build()

            assertEquals(listOf(joined.id), authorizeGroups(request).authorizedChatIdsList)
            authenticationService.logout(bearer)
            val rejected = assertThrows(StatusRuntimeException::class.java) { authorizeGroups(request) }
            assertEquals(Status.Code.UNAUTHENTICATED, rejected.status.code)
        }

        @Test
        fun `session validation derives persisted identity and rejects invalid or expired session IDs`() {
            val username = "session_${UUID.randomUUID().toString().replace("-", "").take(20)}"
            val created = authenticationService.register(username, "long-demo-password", "persisted-device")
            val request = ValidateSessionRequest.newBuilder().setSessionId(created.session.sessionId.value).build()

            val response = validate(request)
            assertEquals(created.session.userId.value, response.userId)
            assertEquals("persisted-device", response.deviceId)
            assertEquals(created.session.sessionId.value, response.sessionId)
            for (value in listOf("", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), created.token.value)) {
                assertEquals(Status.Code.UNAUTHENTICATED, validateError(request.toBuilder().setSessionId(value).build()).status.code)
            }
            assertEquals(Status.Code.UNAUTHENTICATED, validateError(request.toBuilder().setSessionId("0".repeat(64)).build()).status.code)
            db.update(SESSIONS).set(SESSIONS.EXPIRES_AT, OffsetDateTime.now().minusSeconds(1))
                .where(SESSIONS.TOKEN_HASH.eq(created.session.sessionId.value)).execute()
            assertEquals(Status.Code.UNAUTHENTICATED, validateError(request).status.code)
        }

        @Test
        fun `failed identity comparison rolls back session deletion before any revocation event`() {
            val credentials = authenticationService.register(
                username = "rollback_${newId().lowercase()}",
                password = "long-demo-password",
                deviceId = "current-device",
            )
            val failure = assertThrows(ApiException::class.java) {
                authenticationService.logout(
                    token = credentials.token,
                    expectedIdentity = ExpectedSessionIdentity(
                        userIds = listOf(credentials.session.userId.value),
                        deviceIds = listOf("stale-device"),
                    ),
                )
            }
            assertEquals(org.springframework.http.HttpStatus.UNAUTHORIZED, failure.status)
            assertEquals(credentials.session.sessionId, authenticationService.authenticatedSession(credentials.token).sessionId)
            assertEquals(0, revocationCount(sessionId = credentials.session.sessionId.value))
        }

        @Test
        fun `expired sessions are deleted and revoked despite stale or duplicate expected identity`() {
            val credentials = authenticationService.register(username = "expired_${newId().lowercase()}", password = "long-demo-password")
            db.update(SESSIONS).set(SESSIONS.EXPIRES_AT, OffsetDateTime.now().minusSeconds(1))
                .where(SESSIONS.TOKEN_HASH.eq(credentials.session.sessionId.value)).execute()

            authenticationService.logout(
                token = credentials.token,
                expectedIdentity = ExpectedSessionIdentity(userIds = listOf("stale", "stale")),
            )
            authenticationService.logout(token = credentials.token)

            assertThrows(ApiException::class.java) { authenticationService.authenticatedSession(credentials.token) }
            assertEquals(1, revocationCount(sessionId = credentials.session.sessionId.value))
        }

        @Test
        fun `concurrent logouts commit exactly one session revocation`() {
            val credentials = authenticationService.register(
                username = "concurrent_${newId().lowercase()}",
                password = "long-demo-password",
            )
            val ready = CountDownLatch(2)
            val start = CountDownLatch(1)
            val executor = Executors.newFixedThreadPool(2)
            try {
                val results = List(2) {
                    executor.submit {
                        ready.countDown()
                        check(start.await(5, TimeUnit.SECONDS))
                        authenticationService.logout(token = credentials.token)
                    }
                }
                assertTrue(ready.await(5, TimeUnit.SECONDS))
                start.countDown()
                results.forEach { it.get(10, TimeUnit.SECONDS) }
            } finally {
                start.countDown()
                executor.shutdownNow()
                assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
            }
            assertThrows(ApiException::class.java) { authenticationService.authenticatedSession(credentials.token) }
            assertEquals(1, revocationCount(sessionId = credentials.session.sessionId.value))
        }

        @Test
        fun `failed outbox persistence rolls back logout and permits retry`() {
            val credentials = authenticationService.register(username = "outbox_${newId().lowercase()}", password = "long-demo-password")
            val constraint = DSL.name("reject_revocation_${newId().lowercase()}")
            val sessionId = credentials.session.sessionId.value
            db.alterTable(MESSENGER_OUTBOX_EVENTS).add(
                DSL.constraint(
                    constraint,
                ).check(DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "sessionId").isDistinctFrom(sessionId)),
            ).execute()
            try {
                assertThrows(DataIntegrityViolationException::class.java) {
                    authenticationService.logout(token = credentials.token)
                }
                assertEquals(credentials.session.sessionId, authenticationService.authenticatedSession(credentials.token).sessionId)
                assertEquals(0, revocationCount(sessionId = sessionId))
            } finally {
                db.alterTable(MESSENGER_OUTBOX_EVENTS).dropConstraint(constraint).execute()
            }

            authenticationService.logout(token = credentials.token)
            assertEquals(1, revocationCount(sessionId = sessionId))
        }

        @Test
        fun `session validation reads sessions alone and logout skips preliminary lookup`() {
            val credentials = authenticationService.register(username = "queries_${newId().lowercase()}", password = "long-demo-password")
            val validation = statements {
                authenticationService.authenticatedSession(token = credentials.token)
            }
            assertEquals(1, validation.size)
            assertTrue(validation.single().lowercase().contains("sessions"))
            assertTrue(!validation.single().lowercase().contains("users"))

            val logout = statements { authenticationService.logout(token = credentials.token) }
            assertEquals(2, logout.size)
            assertTrue(logout[0].trimStart().startsWith("delete", ignoreCase = true))
            assertTrue(logout[1].trimStart().startsWith("insert", ignoreCase = true))
        }

        @Test
        fun `each authorization RPC reads current session and memberships in one statement`() {
            val credentials = authenticationService.register(username = "rpc_${newId().lowercase()}", password = "long-demo-password")
            val missing = newId()
            val batch = AuthorizeGroupsRequest.newBuilder().setSessionId(credentials.session.sessionId.value).addChatIds(missing).build()
            val single = AuthorizeGroupRequest.newBuilder().setSessionId(credentials.session.sessionId.value).setChatId(missing).build()

            assertEquals(1, statements { assertEquals(emptyList<String>(), authorizeGroups(batch).authorizedChatIdsList) }.size)
            assertEquals(
                1,
                statements {
                    val rejected = assertThrows(StatusRuntimeException::class.java) { authorizeGroup(single) }
                    assertEquals(Status.Code.PERMISSION_DENIED, rejected.status.code)
                }.size,
            )
            assertEquals(
                1,
                statements {
                    validate(ValidateSessionRequest.newBuilder().setSessionId(credentials.session.sessionId.value).build())
                }.size,
            )
            authenticationService.logout(token = credentials.token)
            val expired = assertThrows(StatusRuntimeException::class.java) { authorizeGroups(batch) }
            assertEquals(Status.Code.UNAUTHENTICATED, expired.status.code)
            val malformed =
                assertThrows(StatusRuntimeException::class.java) { authorizeGroup(single.toBuilder().setChatId("invalid").build()) }
            assertEquals(Status.Code.UNAUTHENTICATED, malformed.status.code)
            val malformedBatch = assertThrows(StatusRuntimeException::class.java) {
                authorizeGroups(batch.toBuilder().clearChatIds().addChatIds("invalid").build())
            }
            assertEquals(Status.Code.INVALID_ARGUMENT, malformedBatch.status.code)
        }

        private fun revocationCount(sessionId: String): Int = db.fetchCount(
            MESSENGER_OUTBOX_EVENTS,
            DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq("session_revoked"),
            DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "sessionId").eq(sessionId),
        )

        private fun statements(action: () -> Unit): List<String> {
            val statements = mutableListOf<String>()
            val owner = Thread.currentThread()
            val listener = object : ExecuteListener {
                override fun executeStart(ctx: ExecuteContext) {
                    if (Thread.currentThread() == owner) statements.add(requireNotNull(ctx.sql()).substringAfter("*/ "))
                }
            }
            val configuration = db.configuration()
            val previous = configuration.executeListenerProviders()
            configuration.set(*previous, DefaultExecuteListenerProvider(listener))
            try {
                action()
                return statements.toList()
            } finally {
                configuration.set(*previous)
            }
        }

        private fun authorizeGroup(request: AuthorizeGroupRequest): AuthorizeGroupResponse {
            var value: AuthorizeGroupResponse? = null
            var error: Throwable? = null
            chatAuthorizationGrpcService.authorizeGroup(
                request,
                object : StreamObserver<AuthorizeGroupResponse> {
                    override fun onNext(response: AuthorizeGroupResponse) {
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

        private fun authorizeGroups(request: AuthorizeGroupsRequest): AuthorizeGroupsResponse {
            var value: AuthorizeGroupsResponse? = null
            var error: Throwable? = null
            chatAuthorizationGrpcService.authorizeGroups(
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
            chatAuthorizationGrpcService.validateSession(
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
