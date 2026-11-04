package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.Session
import com.andrewtinyakov.messenger.auth.model.UserAccount
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqAuthRepository(
    private val db: DSLContext,
) : AuthRepository {
    override fun insertUser(id: String, username: String, passwordHash: String) {
        check(
            db.insertInto(USERS)
                .set(USERS.ID, id)
                .set(USERS.USERNAME, username)
                .set(USERS.PASSWORD_HASH, passwordHash)
                .execute() == 1,
        )
    }

    override fun findUserByUsername(username: String): UserAccount? =
        db.selectFrom(USERS)
            .where(USERS.USERNAME.eq(username))
            .fetchOne()?.let { UserAccount(it.id!!, it.username!!, it.passwordHash!!) }

    override fun insertSession(tokenHash: String, userId: String, deviceId: String, expiresAt: OffsetDateTime) {
        check(
            db.insertInto(SESSIONS)
                .set(SESSIONS.TOKEN_HASH, tokenHash)
                .set(SESSIONS.USER_ID, userId)
                .set(SESSIONS.DEVICE_ID, deviceId)
                .set(SESSIONS.EXPIRES_AT, expiresAt)
                .execute() == 1,
        )
    }

    override fun findSession(tokenHash: String, now: OffsetDateTime): Session? =
        db.select(SESSIONS.USER_ID, USERS.USERNAME, SESSIONS.DEVICE_ID, SESSIONS.TOKEN_HASH)
            .from(SESSIONS)
            .join(USERS).on(SESSIONS.USER_ID.eq(USERS.ID))
            .where(SESSIONS.TOKEN_HASH.eq(tokenHash), SESSIONS.EXPIRES_AT.gt(now))
            .fetchOne()?.let { Session(it.value1()!!, it.value2()!!, it.value3()!!, it.value4()!!.trim()) }

    override fun isActiveSession(tokenHash: String, userId: String, deviceId: String, now: OffsetDateTime): Boolean =
        db.fetchExists(
            db.selectOne()
                .from(SESSIONS)
                .where(
                    SESSIONS.TOKEN_HASH.eq(tokenHash),
                    SESSIONS.USER_ID.eq(userId),
                    SESSIONS.DEVICE_ID.eq(deviceId),
                    SESSIONS.EXPIRES_AT.gt(now),
                ),
        )

    override fun deleteSession(tokenHash: String): String? =
        db.deleteFrom(SESSIONS)
            .where(SESSIONS.TOKEN_HASH.eq(tokenHash))
            .returningResult(SESSIONS.USER_ID)
            .fetchOne(SESSIONS.USER_ID)
}
