package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.DeviceId
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import java.time.OffsetDateTime

interface SessionRepository {
    fun insertSession(sessionId: SessionId, userId: UserId, deviceId: DeviceId, expiresAt: OffsetDateTime)

    fun findSession(sessionId: SessionId, now: OffsetDateTime): AuthenticatedSession?

    fun deleteSession(sessionId: SessionId): AuthenticatedSession?

    fun deleteExpired(now: OffsetDateTime, limit: Int): Int
}
