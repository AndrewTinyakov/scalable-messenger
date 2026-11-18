package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.model.LoginAttempt
import com.andrewtinyakov.messenger.auth.model.LoginThrottle
import com.andrewtinyakov.messenger.auth.repository.LoginThrottleRepository
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseTransaction
import com.andrewtinyakov.messenger.infrastructure.database.observedExecute
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime

private const val MAX_DELAY_DOUBLINGS = 30
private const val MAX_CLIENT_LENGTH = 64

private fun throttleKey(username: String, clientIp: String?): String = "$username@${clientIp.orEmpty().take(MAX_CLIENT_LENGTH)}"

@Service
class LoginThrottleService(
    private val repository: LoginThrottleRepository,
    private val properties: AuthProperties,
    private val clock: Clock,
    private val tx: TransactionTemplate,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    fun reserveAttempt(username: String, clientIp: String?): LoginAttempt = tx.observedExecute(DatabaseTransaction.AUTH_LOGIN_THROTTLE) {
        val policy = properties.loginThrottle
        val key = throttleKey(username = username, clientIp = clientIp)
        val current = repository.lockThrottle(key = key, now = OffsetDateTime.now(clock))
        val now = OffsetDateTime.now(clock)
        if (current.blockedUntil.isAfter(now)) return@observedExecute LoginAttempt.Blocked(Duration.between(now, current.blockedUntil))
        val attempts = if (current.lastAttemptAt.isAfter(now.minus(policy.resetAfter))) current.attemptCount + 1 else 1
        repository.saveThrottle(
            key = key,
            throttle = LoginThrottle(attemptCount = attempts, lastAttemptAt = now, blockedUntil = now.plus(delayAfter(attempts))),
        )
        LoginAttempt.Allowed
    }

    fun clear(username: String, clientIp: String?) = repository.deleteThrottle(key = throttleKey(username = username, clientIp = clientIp))

    fun deleteStaleThrottles() {
        try {
            val batchSize = properties.sessionCleanupBatchSize
            while (deleteStaleBatch(batchSize = batchSize) == batchSize) {
                Thread.yield()
            }
        } catch (error: RuntimeException) {
            logger.warn("Stale login throttle cleanup will retry", error)
        }
    }

    private fun deleteStaleBatch(batchSize: Int): Int {
        val now = OffsetDateTime.now(clock)
        return repository.deleteStale(lastAttemptAtOrBefore = now.minus(properties.loginThrottle.resetAfter), now = now, limit = batchSize)
    }

    private fun delayAfter(attempts: Int): Duration {
        val policy = properties.loginThrottle
        if (attempts < policy.freeAttempts) return Duration.ZERO
        val doublings = (attempts - policy.freeAttempts).coerceAtMost(MAX_DELAY_DOUBLINGS)
        val delay = policy.baseDelay.multipliedBy(1L shl doublings)
        return if (delay > policy.maxDelay) policy.maxDelay else delay
    }
}
