package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.DeviceId
import com.andrewtinyakov.messenger.auth.model.DeviceLabel
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.SessionSummary
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.SessionsRecord
import org.jooq.DSLContext
import org.jooq.impl.DSL
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
        deviceLabel: DeviceLabel,
        now: OffsetDateTime,
        expiresAt: OffsetDateTime,
    ) = DatabaseObservation.query(DatabaseOperation.SESSION_INSERT_SESSION) {
        val inserted = db.insertInto(SESSIONS)
            .set(SESSIONS.TOKEN_HASH, sessionId.value)
            .set(SESSIONS.USER_ID, userId.value)
            .set(SESSIONS.DEVICE_ID, deviceId.value)
            .set(SESSIONS.DEVICE_LABEL, deviceLabel.value)
            .set(SESSIONS.CREATED_AT, now)
            .set(SESSIONS.LAST_USED_AT, now)
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

    override fun findSessions(sessionIds: Collection<SessionId>, now: OffsetDateTime): List<AuthenticatedSession> =
        DatabaseObservation.query(DatabaseOperation.SESSION_FIND_MANY) {
            db.selectFrom(SESSIONS)
                .where(SESSIONS.TOKEN_HASH.`in`(sessionIds.map { it.value }), SESSIONS.EXPIRES_AT.gt(now))
                .fetch { it.toSession() }
        }

    override fun findUserSessions(userId: UserId, now: OffsetDateTime, limit: Int): List<SessionSummary> =
        DatabaseObservation.query(DatabaseOperation.SESSION_FIND_BY_USER) {
            db.selectFrom(SESSIONS)
                .where(SESSIONS.USER_ID.eq(userId.value), SESSIONS.EXPIRES_AT.gt(now))
                .orderBy(SESSIONS.LAST_USED_AT.desc(), SESSIONS.CREATED_AT.desc(), SESSIONS.TOKEN_HASH)
                .limit(limit)
                .fetch { record ->
                    SessionSummary(
                        sessionId = SessionId(record.tokenHash!!.trim()),
                        deviceLabel = DeviceLabel(record.deviceLabel!!),
                        createdAt = record.createdAt!!.toInstant(),
                        lastUsedAt = record.lastUsedAt!!.toInstant(),
                    )
                }
        }

    override fun renewSession(
        sessionId: SessionId,
        usedAtOrBefore: OffsetDateTime,
        now: OffsetDateTime,
        expiresAt: OffsetDateTime,
    ): AuthenticatedSession? = DatabaseObservation.query(DatabaseOperation.SESSION_RENEW) {
        db.update(SESSIONS)
            .set(SESSIONS.LAST_USED_AT, now)
            .set(SESSIONS.EXPIRES_AT, expiresAt)
            .where(
                SESSIONS.TOKEN_HASH.eq(sessionId.value),
                SESSIONS.LAST_USED_AT.le(usedAtOrBefore),
                SESSIONS.EXPIRES_AT.gt(now),
            )
            .returning()
            .fetchOne()?.toSession()
    }

    override fun deleteSession(sessionId: SessionId): AuthenticatedSession? = DatabaseObservation.query(
        DatabaseOperation.SESSION_DELETE_SESSION,
    ) {
        db.deleteFrom(SESSIONS)
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value))
            .returning()
            .fetchOne()?.toSession()
    }

    override fun retireUserSession(
        userId: UserId,
        sessionId: SessionId,
        now: OffsetDateTime,
        until: OffsetDateTime,
    ): AuthenticatedSession? = DatabaseObservation.query(DatabaseOperation.SESSION_RETIRE_USER_SESSION) {
        db.update(SESSIONS)
            .set(SESSIONS.EXPIRES_AT, DSL.least(SESSIONS.EXPIRES_AT, DSL.`val`(until)))
            .set(SESSIONS.LAST_USED_AT, now)
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.USER_ID.eq(userId.value), SESSIONS.EXPIRES_AT.gt(now))
            .returning()
            .fetchOne()?.toSession()
    }

    override fun deleteUserSession(userId: UserId, sessionId: SessionId): AuthenticatedSession? = DatabaseObservation.query(
        DatabaseOperation.SESSION_DELETE_USER_SESSION,
    ) {
        db.deleteFrom(SESSIONS)
            .where(SESSIONS.TOKEN_HASH.eq(sessionId.value), SESSIONS.USER_ID.eq(userId.value))
            .returning()
            .fetchOne()?.toSession()
    }

    override fun deleteOtherUserSessions(userId: UserId, keptSessionId: SessionId): List<SessionId> = DatabaseObservation.query(
        DatabaseOperation.SESSION_DELETE_OTHER_USER_SESSIONS,
    ) {
        db.deleteFrom(SESSIONS)
            .where(SESSIONS.USER_ID.eq(userId.value), SESSIONS.TOKEN_HASH.ne(keptSessionId.value))
            .returning(SESSIONS.TOKEN_HASH)
            .fetch { SessionId(it.tokenHash!!.trim()) }
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
        lastUsedAt = lastUsedAt!!.toInstant(),
    )
}
