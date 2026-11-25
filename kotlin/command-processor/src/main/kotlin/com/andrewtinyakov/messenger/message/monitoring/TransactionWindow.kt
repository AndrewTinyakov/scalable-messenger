package com.andrewtinyakov.messenger.message.monitoring

import io.micrometer.core.instrument.Timer
import java.time.Duration

internal class TransactionWindow(
    private val requests: Int,
    private val transaction: Timer,
    private val hold: Timer,
    private val completion: Timer,
) {
    private val started = System.nanoTime()
    private var state: TransactionWindowState = TransactionWindowState.Executing()

    fun chatLocked() {
        if (state is TransactionWindowState.Executing) {
            state = TransactionWindowState.Executing(System.nanoTime())
        }
    }

    fun callbackFinished() {
        state = when (val current = state) {
            is TransactionWindowState.Executing -> TransactionWindowState.CallbackFinished(current.locked, System.nanoTime())
            is TransactionWindowState.CallbackFinished -> current.copy(finished = System.nanoTime())
            TransactionWindowState.Observed -> return
        }
    }

    fun completed() {
        val current = state
        if (current == TransactionWindowState.Observed) return
        state = TransactionWindowState.Observed
        val locked = when (current) {
            is TransactionWindowState.Executing -> current.locked
            is TransactionWindowState.CallbackFinished -> current.locked
            TransactionWindowState.Observed -> return
        }
        val callbackFinished = (current as? TransactionWindowState.CallbackFinished)?.finished
        val finished = System.nanoTime()
        repeat(requests) {
            transaction.record(Duration.ofNanos(finished - started))
            locked?.let { hold.record(Duration.ofNanos(finished - it)) }
            callbackFinished?.let { completion.record(Duration.ofNanos(finished - it)) }
        }
    }
}
