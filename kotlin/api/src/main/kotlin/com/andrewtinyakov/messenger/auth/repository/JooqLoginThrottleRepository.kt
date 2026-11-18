package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.LoginThrottle
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.LOGIN_THROTTLES
import org.jooq.DSLContext
import org.jooq.impl.DSL.excluded
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqLoginThrottleRepository(
    private val db: DSLContext,
) : LoginThrottleRepository {
    override fun lockThrottle(key: String, now: OffsetDateTime): LoginThrottle =
        DatabaseObservation.query(DatabaseOperation.LOGIN_THROTTLE_LOCK) {
            db.insertInto(LOGIN_THROTTLES)
                .set(LOGIN_THROTTLES.THROTTLE_KEY, key)
                .set(LOGIN_THROTTLES.ATTEMPT_COUNT, 0)
                .set(LOGIN_THROTTLES.LAST_ATTEMPT_AT, now)
                .set(LOGIN_THROTTLES.BLOCKED_UNTIL, now)
                .onConflict(LOGIN_THROTTLES.THROTTLE_KEY)
                .doUpdate()
                .set(LOGIN_THROTTLES.THROTTLE_KEY, excluded(LOGIN_THROTTLES.THROTTLE_KEY))
                .returning()
                .fetchSingle { record ->
                    LoginThrottle(
                        attemptCount = record.attemptCount!!,
                        lastAttemptAt = record.lastAttemptAt!!,
                        blockedUntil = record.blockedUntil!!,
                    )
                }
        }

    override fun saveThrottle(key: String, throttle: LoginThrottle) = DatabaseObservation.query(
        DatabaseOperation.LOGIN_THROTTLE_SAVE,
    ) {
        val updated = db.update(LOGIN_THROTTLES)
            .set(LOGIN_THROTTLES.ATTEMPT_COUNT, throttle.attemptCount)
            .set(LOGIN_THROTTLES.LAST_ATTEMPT_AT, throttle.lastAttemptAt)
            .set(LOGIN_THROTTLES.BLOCKED_UNTIL, throttle.blockedUntil)
            .where(LOGIN_THROTTLES.THROTTLE_KEY.eq(key))
            .execute()
        check(updated == 1)
    }

    override fun deleteThrottle(key: String) {
        DatabaseObservation.query(DatabaseOperation.LOGIN_THROTTLE_DELETE) {
            db.deleteFrom(LOGIN_THROTTLES).where(LOGIN_THROTTLES.THROTTLE_KEY.eq(key)).execute()
        }
    }

    override fun deleteStale(lastAttemptAtOrBefore: OffsetDateTime, now: OffsetDateTime, limit: Int): Int = DatabaseObservation.query(
        DatabaseOperation.LOGIN_THROTTLE_DELETE_STALE,
    ) {
        db.deleteFrom(LOGIN_THROTTLES)
            .where(
                LOGIN_THROTTLES.THROTTLE_KEY.`in`(
                    db.select(LOGIN_THROTTLES.THROTTLE_KEY)
                        .from(LOGIN_THROTTLES)
                        .where(LOGIN_THROTTLES.LAST_ATTEMPT_AT.le(lastAttemptAtOrBefore), LOGIN_THROTTLES.BLOCKED_UNTIL.le(now))
                        .orderBy(LOGIN_THROTTLES.LAST_ATTEMPT_AT)
                        .limit(limit)
                        .forUpdate()
                        .skipLocked(),
                ),
            )
            .execute()
    }
}
