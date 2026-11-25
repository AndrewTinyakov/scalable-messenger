package com.andrewtinyakov.messenger.infrastructure.database

import io.micrometer.observation.Observation
import io.micrometer.observation.ObservationRegistry
import org.springframework.http.server.observation.ServerRequestObservationContext
import org.springframework.scheduling.support.ScheduledTaskObservationContext

private val threadNumbers = Regex("[-_#.]?\\d+")

class EntryPointResolver(
    private val observations: ObservationRegistry,
) {
    fun current(): EntryPoint {
        var context: Observation.ContextView = observations.currentObservation?.contextView ?: return thread()
        while (true) context = context.parentObservation?.contextView ?: break
        return when (context) {
            is ServerRequestObservationContext -> {
                EntryPoint("route", "${context.carrier?.method ?: "UNKNOWN"} ${context.pathPattern ?: "unmatched"}")
            }

            is ScheduledTaskObservationContext -> {
                EntryPoint("job", "${context.targetClass.simpleName}.${context.method.name}")
            }

            else -> {
                rpc(context) ?: thread()
            }
        }
    }

    private fun rpc(context: Observation.ContextView): EntryPoint? {
        val service = context.getLowCardinalityKeyValue("rpc.service")?.value ?: return null
        val method = context.getLowCardinalityKeyValue("rpc.method")?.value ?: return null
        return EntryPoint("rpc", "$service/$method")
    }

    private fun thread(): EntryPoint = EntryPoint("thread", Thread.currentThread().name.replace(threadNumbers, "").ifEmpty { "unnamed" })
}
