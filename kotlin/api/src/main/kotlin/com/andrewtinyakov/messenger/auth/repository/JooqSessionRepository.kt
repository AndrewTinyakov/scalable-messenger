package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.DeviceId
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.SessionsRecord
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqSessionRepository(
    private val db: DSLContext,
) : SessionRepository {
    override fun insertSession(
        sessionId: SessionId,
        userId: UserId,
        deviceId: DeviceId,
        expiresAt: OffsetDateTime,
    ) = DatabaseObservation.query(DatabaseOperation.SESSION_INSERT_SESSION) {
        val inserted = db.insertInto(SESSIONS)
            .set(SESSIONS.TOKEN_HASH, sessionId.value)
            .set(SESSIONS.USER_ID, userId.value)
            .set(SESSIONS.DEVICE_ID, deviceId.value)
            .set(SESSIONS.EXPIRES_AT, expiresAt)
            .execute()
        check(inserted == 1)
    }

    override fun findSession(sessionId: SessionId, now: OffsetDateTime): AuthenticatedSession? = DatabaseObservation.query(
        DatabaseOperation.SESSION_FIND,
    ) {
        db.selectFrom(SESSIONS)
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.EXPIRES_AT.gt(now))
            .fetchOne()?.toSession()
    }

    override fun deleteSession(sessionId: SessionId): AuthenticatedSession? = DatabaseObservation.query(
        DatabaseOperation.SESSION_DELETE_SESSION,
    ) {
        db.deleteFrom(SESSIONS)
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value))
            .returning(SESSIONS.USER_ID, SESSIONS.DEVICE_ID, SESSIONS.TOKEN_HASH, SESSIONS.EXPIRES_AT)
            .fetchOne()?.toSession()
    }

    override fun deleteExpired(now: OffsetDateTime, limit: Int): Int = DatabaseObservation.query(
        DatabaseOperation.SESSION_DELETE_EXPIRED,
    ) {
        db.deleteFrom(SESSIONS)
            .where(
                SESSIONS.TOKEN_HASH.`in`(
                    db.select(SESSIONS.TOKEN_HASH)
                        .from(SESSIONS)
                        .where(SESSIONS.EXPIRES_AT.le(now))
                        .orderBy(SESSIONS.EXPIRES_AT)
                        .limit(limit)
                        .forUpdate()
                        .skipLocked(),
                ),
            )
            .execute()
    }

    private fun SessionsRecord.toSession(): AuthenticatedSession = AuthenticatedSession(
        userId = UserId(userId!!),
        deviceId = DeviceId(deviceId!!),
        sessionId = SessionId(tokenHash!!.trim()),
        expiresAt = expiresAt!!.toInstant(),
    )
}
