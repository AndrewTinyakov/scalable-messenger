package com.andrewtinyakov.messenger.auth.repository

import com.andrewtinyakov.messenger.auth.model.LoginThrottle
import java.time.OffsetDateTime

interface LoginThrottleRepository {
    fun lockThrottle(key: String, now: OffsetDateTime): LoginThrottle

    fun saveThrottle(key: String, throttle: LoginThrottle)

    fun deleteThrottle(key: String)

    fun deleteStale(lastAttemptAtOrBefore: OffsetDateTime, now: OffsetDateTime, limit: Int): Int
}
