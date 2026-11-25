package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.messaging.SessionOutbox
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.SessionSummary
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime

private const val LISTED_SESSIONS_LIMIT = 100

@Service
class SessionManagementService(
    private val sessionRepository: SessionRepository,
    private val sessionOutbox: SessionOutbox,
    private val clock: Clock,
    private val tx: TransactionTemplate,
) {
    fun listSessions(userId: UserId): List<SessionSummary> =
        sessionRepository.findUserSessions(userId = userId, now = OffsetDateTime.now(clock), limit = LISTED_SESSIONS_LIMIT)

    fun revokeSession(userId: UserId, sessionId: SessionId) = tx.executeWithoutResult {
        sessionRepository.deleteUserSession(userId = userId, sessionId = sessionId) ?: notFound()
        sessionOutbox.enqueueRevoked(userId = userId, sessionIds = listOf(sessionId))
    }

    fun revokeOtherSessions(userId: UserId, currentSessionId: SessionId): Int =
        tx.execute {
            val revoked = sessionRepository.deleteOtherUserSessions(userId = userId, keptSessionId = currentSessionId)
            sessionOutbox.enqueueRevoked(userId = userId, sessionIds = revoked)
            revoked.size
        }
}
