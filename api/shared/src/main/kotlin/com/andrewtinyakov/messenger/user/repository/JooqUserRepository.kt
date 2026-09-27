package com.andrewtinyakov.messenger.user.repository

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.user.model.User
import org.jooq.DSLContext
import org.springframework.stereotype.Repository

@Repository
class JooqUserRepository(
    private val db: DSLContext,
) : UserRepository {
    override fun existsById(userId: String): Boolean =
        db.fetchExists(db.selectOne().from(USERS).where(USERS.ID.eq(userId)))

    override fun countExisting(userIds: List<String>): Int =
        db.selectCount().from(USERS).where(USERS.ID.`in`(userIds)).fetchOne(0, Int::class.java)!!

    override fun search(query: String): List<User> =
        db.select(USERS.ID, USERS.USERNAME)
            .from(USERS)
            .where(USERS.USERNAME.like("%${query.lowercase().replace("%", "\\%").replace("_", "\\_")}%"))
            .orderBy(USERS.USERNAME)
            .limit(30)
            .fetch { User(it.value1()!!, it.value2()!!) }
}
