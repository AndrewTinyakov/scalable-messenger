package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.shared.id.DeviceId
import com.andrewtinyakov.messenger.shared.id.SessionId
import com.andrewtinyakov.messenger.shared.id.UserId
import java.time.OffsetDateTime

interface SessionRepository {
    fun insertSession(sessionId: SessionId, userId: UserId, deviceId: DeviceId, expiresAt: OffsetDateTime)

    fun findSession(sessionId: SessionId, now: OffsetDateTime): AuthenticatedSession?

    fun deleteSession(sessionId: SessionId): AuthenticatedSession?
}
