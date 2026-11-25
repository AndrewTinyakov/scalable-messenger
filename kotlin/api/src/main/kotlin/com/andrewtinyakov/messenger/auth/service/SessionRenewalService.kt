package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.OffsetDateTime

@Service
class SessionRenewalService(
    private val sessionRepository: SessionRepository,
    private val properties: AuthProperties,
    private val clock: Clock,
) {
    fun renewIfDue(session: AuthenticatedSession): AuthenticatedSession? {
        val now = OffsetDateTime.now(clock)
        val usedAtOrBefore = now.minus(properties.sessionRenewalInterval)
        if (session.lastUsedAt > usedAtOrBefore.toInstant()) return null
        return sessionRepository.renewSession(
            sessionId = session.sessionId,
            usedAtOrBefore = usedAtOrBefore,
            now = now,
            expiresAt = now.plus(properties.sessionLifetime),
        )
    }
}
