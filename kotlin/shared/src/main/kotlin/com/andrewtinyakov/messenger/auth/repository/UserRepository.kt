package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary

interface UserRepository {
    fun insertUser(user: User)

    fun findUserByUsername(username: String): User?

    fun findUser(userId: UserId): User?

    fun lockPasswordHash(userId: UserId): String?

    fun replacePasswordHash(userId: UserId, expectedHash: String, newHash: String): Boolean

    fun findSummary(userId: UserId): UserSummary?

    fun existsById(userId: UserId): Boolean

    fun search(query: String): List<UserSummary>
}
