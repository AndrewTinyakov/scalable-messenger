package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.LOGIN_THROTTLES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.jooq.ExecuteContext
import org.jooq.ExecuteListener
import org.jooq.impl.DSL
import org.jooq.impl.DefaultExecuteListenerProvider
import org.jooq.types.DayToSecond
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.clearInvocations
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.http.HttpStatus
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.test.context.TestPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean
import java.time.Duration
import java.time.OffsetDateTime
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@TestPropertySource(
    properties = [
        "messenger.auth.login-throttle.free-attempts=3",
        "messenger.auth.login-throttle.base-delay=1h",
        "messenger.auth.login-throttle.max-delay=2h",
        "messenger.auth.login-throttle.reset-after=24h",
    ],
)
class SessionSecurityServiceTests : MessengerIntegrationTest() {
    @Autowired private lateinit var authenticationService: AuthenticationService

    @Autowired private lateinit var sessionRenewalService: SessionRenewalService

    @Autowired private lateinit var sessionManagementService: SessionManagementService

    @Autowired private lateinit var passwordChangeService: PasswordChangeService

    @MockitoSpyBean private lateinit var passwordEncoder: PasswordEncoder

    @Test
    fun `renewal slides expiry after a day of inactivity and otherwise writes nothing`() {
        val credentials = register()
        val fresh = authenticationService.authenticatedSession(credentials.token)

        val skipped = statements { assertNull(sessionRenewalService.renewIfDue(fresh)) }
        assertEquals(emptyList<String>(), skipped)

        val nearlyDue = OffsetDateTime.now().minusHours(23)
        db.update(SESSIONS)
            .set(SESSIONS.LAST_USED_AT, nearlyDue)
            .set(SESSIONS.EXPIRES_AT, nearlyDue.plusDays(30))
            .where(SESSIONS.TOKEN_HASH.eq(fresh.sessionId.value)).execute()
        val recent = authenticationService.authenticatedSession(credentials.token)
        assertEquals(emptyList<String>(), statements { assertNull(sessionRenewalService.renewIfDue(recent)) })

        val lastUsed = OffsetDateTime.now().minusHours(25)
        val expiresAt = lastUsed.plusDays(30)
        db.update(SESSIONS)
            .set(SESSIONS.LAST_USED_AT, lastUsed)
            .set(SESSIONS.EXPIRES_AT, expiresAt)
            .where(SESSIONS.TOKEN_HASH.eq(fresh.sessionId.value)).execute()
        val stale = authenticationService.authenticatedSession(credentials.token)
        val before = OffsetDateTime.now()
        var renewed: AuthenticatedSession? = null
        val writes = statements { renewed = sessionRenewalService.renewIfDue(stale) }
        val after = OffsetDateTime.now()

        assertEquals(1, writes.size)
        assertTrue(writes.single().trimStart().startsWith("update", ignoreCase = true))
        val extended = requireNotNull(renewed)
        assertTrue(!extended.lastUsedAt.isBefore(before.toInstant().minusSeconds(1)) && !extended.lastUsedAt.isAfter(after.toInstant()))
        assertEquals(Duration.ofDays(30), Duration.between(extended.lastUsedAt, extended.expiresAt))
        assertTrue(extended.expiresAt.isAfter(expiresAt.toInstant().plus(Duration.ofHours(24))))
        assertEquals(extended.expiresAt, authenticationService.authenticatedSession(credentials.token).expiresAt)

        assertNull(sessionRenewalService.renewIfDue(stale))
        assertEquals(emptyList<String>(), statements { assertNull(sessionRenewalService.renewIfDue(extended)) })
    }

    @Test
    fun `renewal never revives an expired or revoked session`() {
        val credentials = register()
        val session = authenticationService.authenticatedSession(credentials.token)
        db.update(SESSIONS)
            .set(SESSIONS.LAST_USED_AT, OffsetDateTime.now().minusDays(31))
            .set(SESSIONS.EXPIRES_AT, OffsetDateTime.now().minusDays(1))
            .where(SESSIONS.TOKEN_HASH.eq(session.sessionId.value)).execute()
        val expired = session.copy(lastUsedAt = OffsetDateTime.now().minusDays(31).toInstant())

        assertNull(sessionRenewalService.renewIfDue(expired))
        assertNull(authenticationService.sessionIfActive(credentials.token))

        authenticationService.logout(credentials.token)
        assertNull(sessionRenewalService.renewIfDue(expired))
    }

    @Test
    fun `sessions list only the caller's active sessions with labels and creation order`() {
        val username = "list_${newId().lowercase()}"
        val first = authenticationService.register(
            username,
            "long-demo-password",
            userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        )
        val second = authenticationService.login(
            username,
            "long-demo-password",
            userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Safari/604.1",
        )
        val stranger = register()

        val sessions = sessionManagementService.listSessions(first.session.userId)

        assertEquals(setOf(first.session.sessionId, second.session.sessionId), sessions.map { it.sessionId }.toSet())
        assertEquals("Chrome on macOS", sessions.single { it.sessionId == first.session.sessionId }.deviceLabel.value)
        assertEquals("Safari on iOS", sessions.single { it.sessionId == second.session.sessionId }.deviceLabel.value)
        assertFalse(sessions.any { it.sessionId == stranger.session.sessionId })
    }

    @Test
    fun `revoking another user's session is denied without side effects`() {
        val owner = register()
        val victim = register()

        val failure = assertThrows(ApiException::class.java) {
            sessionManagementService.revokeSession(owner.session.userId, victim.session.sessionId)
        }

        assertEquals(HttpStatus.NOT_FOUND, failure.status)
        assertEquals(victim.session.sessionId, authenticationService.authenticatedSession(victim.token).sessionId)
        assertEquals(0, revocations(victim.session.sessionId.value))
    }

    @Test
    fun `revoking one session deletes it and publishes its revocation in the same commit`() {
        val username = "revoke_${newId().lowercase()}"
        val current = authenticationService.register(username, "long-demo-password")
        val other = authenticationService.login(username, "long-demo-password")

        sessionManagementService.revokeSession(current.session.userId, other.session.sessionId)

        assertNull(authenticationService.sessionIfActive(other.token))
        assertNotNull(authenticationService.sessionIfActive(current.token))
        assertEquals(1, revocations(other.session.sessionId.value))
        assertEquals(0, revocations(current.session.sessionId.value))
        assertThrows(ApiException::class.java) { sessionManagementService.revokeSession(current.session.userId, other.session.sessionId) }
        assertEquals(1, revocations(other.session.sessionId.value))
    }

    @Test
    fun `revoking other sessions keeps the current one and leaves other users untouched`() {
        val username = "others_${newId().lowercase()}"
        val current = authenticationService.register(username, "long-demo-password")
        val others = List(3) { authenticationService.login(username, "long-demo-password") }
        val stranger = register()

        assertEquals(3, sessionManagementService.revokeOtherSessions(current.session.userId, current.session.sessionId))

        assertNotNull(authenticationService.sessionIfActive(current.token))
        assertNotNull(authenticationService.sessionIfActive(stranger.token))
        others.forEach { revoked ->
            assertNull(authenticationService.sessionIfActive(revoked.token))
            assertEquals(1, revocations(revoked.session.sessionId.value))
        }
        assertEquals(0, revocations(current.session.sessionId.value))
        assertEquals(0, revocations(stranger.session.sessionId.value))
        assertEquals(0, sessionManagementService.revokeOtherSessions(current.session.userId, current.session.sessionId))
    }

    @Test
    fun `password change requires the current password and revokes every other session`() {
        val username = "password_${newId().lowercase()}"
        val current = authenticationService.register(username, "long-demo-password")
        val other = authenticationService.login(username, "long-demo-password")

        val rejected = assertThrows(ApiException::class.java) {
            passwordChangeService.changePassword(current.session.userId, current.session.sessionId, "wrong-password", "new-demo-password")
        }
        assertEquals(HttpStatus.FORBIDDEN, rejected.status)
        assertEquals(ApiErrorCode.INVALID_CREDENTIALS, rejected.code)
        assertNotNull(authenticationService.sessionIfActive(other.token))

        val change = passwordChangeService.changePassword(
            current.session.userId,
            current.session.sessionId,
            "long-demo-password",
            "new-demo-password",
        )

        assertEquals(1, change.revokedOtherSessions)
        val retired = checkNotNull(authenticationService.sessionIfActive(current.token))
        assertTrue(Duration.between(java.time.Instant.now(), retired.expiresAt) <= Duration.ofSeconds(60))
        assertNull(authenticationService.sessionIfActive(other.token))
        val rotated = authenticationService.authenticatedSession(change.credentials.token)
        assertEquals(current.session.deviceId, rotated.deviceId)
        assertTrue(rotated.sessionId != current.session.sessionId)
        assertEquals(1, revocations(other.session.sessionId.value))
        assertEquals(1, revocations(current.session.sessionId.value))
        assertThrows(ApiException::class.java) { authenticationService.login(username, "long-demo-password") }
        assertEquals(current.session.userId, authenticationService.login(username, "new-demo-password").session.userId)
        assertEquals(0, throttleRows(username))
    }

    @Test
    fun `password change rolls back when the revocation event cannot be stored`() {
        val username = "rollback_${newId().lowercase()}"
        val current = authenticationService.register(username, "long-demo-password")
        val other = authenticationService.login(username, "long-demo-password")
        val constraint = DSL.name("reject_password_${newId().lowercase()}")
        val sessionId = DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "sessionId")
        db.alterTable(MESSENGER_OUTBOX_EVENTS).add(
            DSL.constraint(constraint).check(sessionId.isDistinctFrom(other.session.sessionId.value)),
        ).execute()
        try {
            assertThrows(DataIntegrityViolationException::class.java) {
                passwordChangeService.changePassword(
                    current.session.userId,
                    current.session.sessionId,
                    "long-demo-password",
                    "new-demo-password",
                )
            }
        } finally {
            db.alterTable(MESSENGER_OUTBOX_EVENTS).dropConstraint(constraint).execute()
        }

        assertNotNull(authenticationService.sessionIfActive(other.token))
        assertEquals(current.session.userId, authenticationService.login(username, "long-demo-password").session.userId)
    }

    @Test
    fun `password change failures share the account backoff`() {
        val username = "change_backoff_${newId().lowercase().take(12)}"
        val current = authenticationService.register(username, "long-demo-password")
        repeat(3) {
            val failure = assertThrows(ApiException::class.java) {
                passwordChangeService.changePassword(
                    current.session.userId,
                    current.session.sessionId,
                    "wrong-password",
                    "new-demo-password",
                )
            }
            assertEquals(HttpStatus.FORBIDDEN, failure.status)
        }

        val blocked = assertThrows(ApiException::class.java) {
            passwordChangeService.changePassword(
                current.session.userId,
                current.session.sessionId,
                "long-demo-password",
                "new-demo-password",
            )
        }
        assertEquals(HttpStatus.TOO_MANY_REQUESTS, blocked.status)
        assertEquals(
            HttpStatus.TOO_MANY_REQUESTS,
            assertThrows(ApiException::class.java) {
                authenticationService.login(username, "long-demo-password")
            }.status,
        )
    }

    @Test
    fun `login backoff treats unknown and existing usernames identically and does the same hashing work`() {
        val existing = "backoff_${newId().lowercase().take(16)}"
        authenticationService.register(existing, "long-demo-password")
        val unknown = "missing_${newId().lowercase().take(16)}"

        for (username in listOf(existing, unknown)) {
            clearInvocations(passwordEncoder)
            val outcomes = List(5) { attemptLogin(username, "wrong-password") }
            val retryAfter = assertThrows(ApiException::class.java) { authenticationService.login(username, "wrong-password") }.retryAfter

            assertEquals(listOf(401, 401, 401, 429, 429), outcomes.map { it.status.value() }, username)
            assertEquals(ApiErrorCode.INVALID_CREDENTIALS, outcomes.first().code)
            assertEquals(ApiErrorCode.TOO_MANY_ATTEMPTS, outcomes.last().code)
            assertEquals(outcomes.last().message, outcomes[3].message)
            assertTrue(retryAfter!! > Duration.ofMinutes(59) && retryAfter <= Duration.ofHours(1), retryAfter.toString())
            verify(passwordEncoder, times(3)).matches(any(), anyString())
        }

        val blockedCorrect = assertThrows(ApiException::class.java) { authenticationService.login(existing, "long-demo-password") }
        assertEquals(HttpStatus.TOO_MANY_REQUESTS, blockedCorrect.status)
    }

    @Test
    fun `login backoff grows after the free attempts and resets on success or after the window`() {
        val username = "reset_${newId().lowercase().take(16)}"
        authenticationService.register(username, "long-demo-password")

        repeat(2) { assertEquals(401, attemptLogin(username, "wrong-password").status.value()) }
        authenticationService.login(username, "long-demo-password")
        assertEquals(0, throttleRows(username))

        repeat(3) { assertEquals(401, attemptLogin(username, "wrong-password").status.value()) }
        assertEquals(
            3,
            db.select(LOGIN_THROTTLES.ATTEMPT_COUNT).from(LOGIN_THROTTLES)
                .where(LOGIN_THROTTLES.THROTTLE_KEY.eq("$username@")).fetchSingle().value1(),
        )
        val firstBlock = blockedFor(username)
        assertTrue(firstBlock > Duration.ofMinutes(59) && firstBlock <= Duration.ofHours(1), firstBlock.toString())

        val expiredBlock = DSL.currentOffsetDateTime().sub(DSL.inline(DayToSecond.valueOf(Duration.ofSeconds(1))))
        db.update(LOGIN_THROTTLES).set(LOGIN_THROTTLES.BLOCKED_UNTIL, expiredBlock)
            .where(LOGIN_THROTTLES.THROTTLE_KEY.eq("$username@")).execute()
        assertEquals(401, attemptLogin(username, "wrong-password").status.value())
        val secondBlock = blockedFor(username)
        assertTrue(secondBlock > Duration.ofMinutes(119) && secondBlock <= Duration.ofHours(2), secondBlock.toString())

        db.update(LOGIN_THROTTLES).set(LOGIN_THROTTLES.BLOCKED_UNTIL, expiredBlock)
            .where(LOGIN_THROTTLES.THROTTLE_KEY.eq("$username@")).execute()
        assertEquals(401, attemptLogin(username, "wrong-password").status.value())
        assertEquals(Duration.ofHours(2).toMinutes(), blockedFor(username).plusSeconds(30).toMinutes())

        db.update(LOGIN_THROTTLES)
            .set(LOGIN_THROTTLES.BLOCKED_UNTIL, expiredBlock)
            .set(LOGIN_THROTTLES.LAST_ATTEMPT_AT, DSL.currentOffsetDateTime().sub(DSL.inline(DayToSecond.valueOf(Duration.ofHours(25)))))
            .where(LOGIN_THROTTLES.THROTTLE_KEY.eq("$username@")).execute()
        assertEquals(401, attemptLogin(username, "wrong-password").status.value())
        assertEquals(
            1,
            db.select(LOGIN_THROTTLES.ATTEMPT_COUNT).from(LOGIN_THROTTLES)
                .where(LOGIN_THROTTLES.THROTTLE_KEY.eq("$username@")).fetchSingle().value1(),
        )
        assertEquals(username, authenticationService.login(username, "long-demo-password").user.username)
        assertEquals(0, throttleRows(username))
    }

    @Test
    fun `concurrent login attempts cannot exceed the free attempts across callers`() {
        val username = "parallel_${newId().lowercase().take(16)}"
        authenticationService.register(username, "long-demo-password")
        val start = CountDownLatch(1)

        val attempts = List(8) {
            concurrently {
                check(start.await(5, TimeUnit.SECONDS))
                attemptLogin(username, "wrong-password").status.value()
            }
        }
        start.countDown()
        val statuses = attempts.map { it.get(60, TimeUnit.SECONDS) }

        assertEquals(3, statuses.count { it == 401 }, statuses.toString())
        assertEquals(5, statuses.count { it == 429 }, statuses.toString())
    }

    @Test
    fun `login rehashes passwords whose encoding is outdated`() {
        val username = "rehash_${newId().lowercase().take(16)}"
        val userId = newId()
        val legacy = BCryptPasswordEncoder().encode("legacy-password")!!
        db.insertInto(USERS, USERS.ID, USERS.USERNAME, USERS.PASSWORD_HASH).values(userId, username, legacy).execute()

        authenticationService.login(username, "legacy-password")
        val upgraded = passwordHash(userId)

        assertTrue(upgraded.startsWith("{pbkdf2-sha256-600000}"), upgraded)
        assertFalse(passwordEncoder.upgradeEncoding(upgraded))
        authenticationService.login(username, "legacy-password")
        assertEquals(upgraded, passwordHash(userId))
        assertThrows(ApiException::class.java) { authenticationService.login(username, "wrong-password") }
        assertEquals(upgraded, passwordHash(userId))
    }

    @Test
    fun `login rejects a password changed while it was being verified`() {
        val username = "race_${newId().lowercase().take(16)}"
        val owner = authenticationService.register(username, "original-password")
        val changed = AtomicBoolean(false)
        doAnswer { invocation ->
            val matches = invocation.callRealMethod() as Boolean
            if (changed.compareAndSet(false, true)) {
                passwordChangeService.changePassword(
                    userId = owner.user.id,
                    currentSessionId = owner.session.sessionId,
                    currentPassword = "original-password",
                    newPassword = "replacement-password",
                )
            }
            matches
        }.`when`(passwordEncoder).matches(anyString(), anyString())

        val rejected = attemptLogin(username, "original-password")

        assertTrue(changed.get())
        assertEquals(HttpStatus.UNAUTHORIZED, rejected.status)
        assertEquals(
            1,
            db.fetchCount(
                SESSIONS,
                SESSIONS.USER_ID.eq(owner.user.id.value),
                SESSIONS.EXPIRES_AT.gt(DSL.currentOffsetDateTime().add(DSL.inline(DayToSecond.valueOf(Duration.ofMinutes(1))))),
            ),
        )
    }

    private fun register(): SessionCredentials = authenticationService.register(
        "user_${newId().lowercase().take(20)}",
        "long-demo-password",
    )

    private fun attemptLogin(username: String, password: String): ApiException =
        assertThrows(ApiException::class.java) { authenticationService.login(username, password) }

    private fun blockedFor(username: String): Duration = Duration.between(
        OffsetDateTime.now(),
        db.select(LOGIN_THROTTLES.BLOCKED_UNTIL).from(LOGIN_THROTTLES)
            .where(LOGIN_THROTTLES.THROTTLE_KEY.eq("$username@")).fetchSingle().value1(),
    )

    private fun throttleRows(username: String): Int =
        db.fetchCount(LOGIN_THROTTLES, LOGIN_THROTTLES.THROTTLE_KEY.eq("$username@"))

    private fun passwordHash(userId: String): String =
        db.select(USERS.PASSWORD_HASH).from(USERS).where(USERS.ID.eq(userId)).fetchSingle().value1()

    private fun revocations(sessionId: String): Int = db.fetchCount(
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
}
