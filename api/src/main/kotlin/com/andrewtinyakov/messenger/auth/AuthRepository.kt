package com.andrewtinyakov.messenger.auth

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

data class StoredUser(
    val id: String,
    val username: String,
    val passwordHash: String,
)

interface AuthRepository {
    fun insertUser(id: String, username: String, passwordHash: String)

    fun findUserByUsername(username: String): StoredUser?

    fun insertSession(tokenHash: String, userId: String, deviceId: String, expiresAt: OffsetDateTime)

    fun findSession(tokenHash: String, now: OffsetDateTime): SessionView?

    fun searchUsers(query: String): List<UserView>
}

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

    override fun findUserByUsername(username: String): StoredUser? =
        db.selectFrom(USERS)
            .where(USERS.USERNAME.eq(username))
            .fetchOne()?.let { StoredUser(it.id!!, it.username!!, it.passwordHash!!) }

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

    override fun findSession(tokenHash: String, now: OffsetDateTime): SessionView? =
        db.select(SESSIONS.USER_ID, USERS.USERNAME, SESSIONS.DEVICE_ID)
            .from(SESSIONS)
            .join(USERS).on(SESSIONS.USER_ID.eq(USERS.ID))
            .where(SESSIONS.TOKEN_HASH.eq(tokenHash), SESSIONS.EXPIRES_AT.gt(now))
            .fetchOne()?.let { SessionView(it.value1()!!, it.value2()!!, it.value3()!!) }

    override fun searchUsers(query: String): List<UserView> =
        db.select(USERS.ID, USERS.USERNAME)
            .from(USERS)
            .where(USERS.USERNAME.like("%${query.lowercase().replace("%", "\\%").replace("_", "\\_")}%"))
            .orderBy(USERS.USERNAME)
            .limit(30)
            .fetch { UserView(it.value1()!!, it.value2()!!) }
}
