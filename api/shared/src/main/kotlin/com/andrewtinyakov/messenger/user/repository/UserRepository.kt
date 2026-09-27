package com.andrewtinyakov.messenger.user.repository

import com.andrewtinyakov.messenger.user.model.User

interface UserRepository {
    fun existsById(userId: String): Boolean

    fun countExisting(userIds: List<String>): Int

    fun search(query: String): List<User>
}
