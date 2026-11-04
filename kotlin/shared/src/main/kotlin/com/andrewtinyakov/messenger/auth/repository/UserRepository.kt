package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.shared.id.UserId

interface UserRepository {
    fun insertUser(user: User)

    fun findUserByUsername(username: String): User?

    fun findSummary(userId: UserId): UserSummary?

    fun existsById(userId: UserId): Boolean

    fun countExisting(userIds: List<UserId>): Int

    fun search(query: String): List<UserSummary>
}
