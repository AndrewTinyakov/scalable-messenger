package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.Session
import com.andrewtinyakov.messenger.auth.model.UserAccount
import java.time.OffsetDateTime

interface AuthRepository {
    fun insertUser(id: String, username: String, passwordHash: String)

    fun findUserByUsername(username: String): UserAccount?

    fun insertSession(tokenHash: String, userId: String, deviceId: String, expiresAt: OffsetDateTime)

    fun findSession(tokenHash: String, now: OffsetDateTime): Session?

    fun isActiveSession(tokenHash: String, userId: String, deviceId: String, now: OffsetDateTime): Boolean

    fun deleteSession(tokenHash: String): String?
}
