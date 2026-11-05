package com.andrewtinyakov.messenger.message.service

import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import java.time.Duration

internal class SendTimers(
    registry: MeterRegistry,
) {
    private val transaction = histogram(registry, "messenger.send.transaction")
    private val hold = histogram(registry, "messenger.send.transaction.hold")
    private val completion = histogram(registry, "messenger.send.transaction.completion")
    private val chatLock = histogram(registry, "messenger.send.chat.lock.acquire")

    fun <T> timeChatLock(acquire: () -> T): T {
        val started = System.nanoTime()
        try {
            return acquire()
        } finally {
            chatLock.record(Duration.ofNanos(System.nanoTime() - started))
        }
    }

    fun window(requests: Int = 1) = TransactionWindow(requests)

    inner class TransactionWindow(
        private val requests: Int,
    ) {
        private val started = System.nanoTime()
        private var locked: Long? = null
        private var callbackFinished: Long? = null
        private var observed = false

        fun chatLocked() {
            locked = System.nanoTime()
        }

        fun callbackFinished() {
            callbackFinished = System.nanoTime()
        }

        fun completed() {
            if (observed) return
            observed = true
            val finished = System.nanoTime()
            repeat(requests) {
                transaction.record(Duration.ofNanos(finished - started))
                locked?.let { hold.record(Duration.ofNanos(finished - it)) }
                callbackFinished?.let { completion.record(Duration.ofNanos(finished - it)) }
            }
        }
    }

    private fun histogram(registry: MeterRegistry, name: String): Timer =
        Timer.builder(name)
            .publishPercentileHistogram()
            .minimumExpectedValue(Duration.ofMillis(1))
            .maximumExpectedValue(Duration.ofMinutes(2))
            .register(registry)
}
