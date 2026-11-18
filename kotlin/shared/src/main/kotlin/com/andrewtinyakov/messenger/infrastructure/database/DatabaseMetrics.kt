package com.andrewtinyakov.messenger.infrastructure.database

import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class DatabaseMetrics(
    private val registry: MeterRegistry,
) {
    private val failures = AtomicLong()
    private val timers = ConcurrentHashMap<List<String>, Timer>()

    init {
        safely { Gauge.builder("messenger.database.instrumentation.failures", failures, AtomicLong::toDouble).register(registry) }
    }

    fun record(name: String, entryPoint: EntryPoint, outcome: String, nanos: Long, phase: String? = null) {
        safely {
            val timer = timers.computeIfAbsent(listOf(name, entryPoint.kind, entryPoint.name, outcome, phase.orEmpty())) {
                val builder = Timer.builder(name)
                    .tags("entrypoint_kind", entryPoint.kind, "entrypoint", entryPoint.name, "outcome", outcome)
                    .serviceLevelObjectives(*BUCKETS)
                if (phase != null) builder.tag("phase", phase)
                builder.register(registry)
            }
            timer.record(nanos.coerceAtLeast(0), TimeUnit.NANOSECONDS)
        }
    }

    private inline fun safely(action: () -> Unit) {
        try {
            action()
        } catch (_: RuntimeException) {
            failures.incrementAndGet()
        }
    }

    companion object {
        private val BUCKETS = longArrayOf(1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)
            .map(Duration::ofMillis).toTypedArray()
    }
}
