package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import org.jooq.DSLContext
import org.jooq.Record2
import org.springframework.stereotype.Repository

private const val SEARCH_RESULT_LIMIT = 30

@Repository
class JooqUserRepository(
    private val db: DSLContext,
) : UserRepository {
    override fun insertUser(user: User) = DatabaseObservation.query(DatabaseOperation.USER_INSERT_USER) {
        val inserted = db.insertInto(USERS)
            .set(USERS.ID, user.id.value)
            .set(USERS.USERNAME, user.username)
            .set(USERS.PASSWORD_HASH, user.passwordHash)
            .execute()
        check(inserted == 1)
    }

    override fun findUserByUsername(username: String): User? = DatabaseObservation.query(DatabaseOperation.USER_FIND_USER_BY_USERNAME) {
        db.selectFrom(USERS)
            .where(USERS.USERNAME.eq(username))
            .fetchOne()?.let { row ->
                User(id = UserId(row.id!!), username = row.username!!, passwordHash = row.passwordHash!!)
            }
    }

    override fun findSummary(userId: UserId): UserSummary? = DatabaseObservation.query(DatabaseOperation.USER_FIND_SUMMARY) {
        db.select(USERS.ID, USERS.USERNAME)
            .from(USERS)
            .where(USERS.ID.eq(userId.value))
            .fetchOne { it.toUserSummary() }
    }

    override fun existsById(userId: UserId): Boolean = DatabaseObservation.query(DatabaseOperation.USER_EXISTS_BY_ID) {
        db.fetchExists(db.selectOne().from(USERS).where(USERS.ID.eq(userId.value)))
    }

    override fun search(query: String): List<UserSummary> = DatabaseObservation.query(DatabaseOperation.USER_SEARCH) {
        db.select(USERS.ID, USERS.USERNAME)
            .from(USERS)
            .where(
                USERS.USERNAME.like("%${query.lowercase().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")}%", '\\'),
            )
            .orderBy(USERS.USERNAME)
            .limit(SEARCH_RESULT_LIMIT)
            .fetch { it.toUserSummary() }
    }
}

private fun Record2<String?, String?>.toUserSummary(): UserSummary =
    UserSummary(
        id = UserId(get(USERS.ID)!!),
        username = get(USERS.USERNAME)!!,
    )
