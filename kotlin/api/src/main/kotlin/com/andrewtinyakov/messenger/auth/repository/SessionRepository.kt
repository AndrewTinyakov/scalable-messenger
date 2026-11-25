package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.DeviceId
import com.andrewtinyakov.messenger.auth.model.DeviceLabel
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.SessionSummary
import com.andrewtinyakov.messenger.auth.model.UserId
import java.time.OffsetDateTime

interface SessionRepository {
    fun insertSession(
        sessionId: SessionId,
        userId: UserId,
        deviceId: DeviceId,
        deviceLabel: DeviceLabel,
        now: OffsetDateTime,
        expiresAt: OffsetDateTime,
    )

    fun findSession(sessionId: SessionId, now: OffsetDateTime): AuthenticatedSession?

    fun findSessions(sessionIds: Collection<SessionId>, now: OffsetDateTime): List<AuthenticatedSession>

    fun findUserSessions(userId: UserId, now: OffsetDateTime, limit: Int): List<SessionSummary>

    fun renewSession(
        sessionId: SessionId,
        usedAtOrBefore: OffsetDateTime,
        now: OffsetDateTime,
        expiresAt: OffsetDateTime,
    ): AuthenticatedSession?

    fun deleteSession(sessionId: SessionId): AuthenticatedSession?

    fun retireUserSession(userId: UserId, sessionId: SessionId, now: OffsetDateTime, until: OffsetDateTime): AuthenticatedSession?

    fun deleteUserSession(userId: UserId, sessionId: SessionId): AuthenticatedSession?

    fun deleteOtherUserSessions(userId: UserId, keptSessionId: SessionId): List<SessionId>

    fun deleteExpired(now: OffsetDateTime, limit: Int): Int
}
