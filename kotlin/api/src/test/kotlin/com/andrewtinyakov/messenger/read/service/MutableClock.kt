package com.andrewtinyakov.messenger.read.service

import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicReference

internal class MutableClock(
    initial: String,
) : Clock() {
    private val value = AtomicReference(Instant.parse(initial))

    fun set(next: String) {
        value.set(Instant.parse(next))
    }

    override fun instant(): Instant = value.get()

    override fun getZone(): ZoneId = ZoneOffset.UTC

    override fun withZone(zone: ZoneId): Clock = Clock.fixed(instant(), zone)
}
