package com.andrewtinyakov.messenger.read.service

import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import org.springframework.stereotype.Component
import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

@Component
class ReadMetrics(
    private val registry: MeterRegistry,
) {
    private val backlog = AtomicInteger()
    private val oldestAge = AtomicLong()

    init {
        Gauge.builder("messenger.read.cleanup.backlog", backlog, AtomicInteger::toDouble).register(registry)
        Gauge.builder("messenger.read.cleanup.oldest.age", oldestAge, AtomicLong::toDouble).baseUnit("seconds").register(registry)
    }

    fun count(name: String, outcome: String, amount: Int = 1) {
        registry.counter("messenger.read.$name", "outcome", outcome).increment(amount.toDouble())
    }

    fun duration(operation: String, started: Long) {
        Timer.builder("messenger.read.duration").tag("operation", operation).publishPercentileHistogram()
            .minimumExpectedValue(Duration.ofMillis(1)).maximumExpectedValue(Duration.ofMinutes(1))
            .register(registry).record(Duration.ofNanos(System.nanoTime() - started))
    }

    fun cleanup(backlogSize: Int, ageSeconds: Long) {
        backlog.set(backlogSize)
        oldestAge.set(ageSeconds.coerceAtLeast(0))
    }
}
