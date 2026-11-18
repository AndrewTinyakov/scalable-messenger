package com.andrewtinyakov.messenger.infrastructure.database

import io.micrometer.observation.Observation
import io.micrometer.observation.ObservationHandler
import io.micrometer.observation.ObservationRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.http.server.observation.ServerRequestObservationContext
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.scheduling.support.ScheduledTaskObservationContext

class EntryPointResolverTests {
    private val registry = ObservationRegistry.create().apply {
        observationConfig().observationHandler(ObservationHandler<Observation.Context> { true })
    }
    private val resolver = EntryPointResolver(registry)

    @Test
    fun `http requests resolve to the matched route template`() {
        val context = ServerRequestObservationContext(MockHttpServletRequest("DELETE", "/v1/auth/sessions/abc"), MockHttpServletResponse())
        context.pathPattern = "/v1/auth/sessions/{sessionId}"
        val resolved = Observation.createNotStarted("http.server.requests", { context }, registry).observe<EntryPoint> {
            Observation.createNotStarted("spring.security.filterchains", registry).observe<EntryPoint> { resolver.current() }
        }
        assertEquals(EntryPoint("route", "DELETE /v1/auth/sessions/{sessionId}"), resolved)
    }

    @Test
    fun `scheduled jobs resolve to their class and method`() {
        val context = ScheduledTaskObservationContext(this, javaClass.getMethod("scheduledJob"))
        val resolved = Observation.createNotStarted("tasks.scheduled.execution", { context }, registry).observe<EntryPoint> {
            resolver.current()
        }
        assertEquals(EntryPoint("job", "EntryPointResolverTests.scheduledJob"), resolved)
    }

    @Test
    fun `rpc observations resolve to service and method`() {
        val resolved = Observation.createNotStarted("grpc.server", registry)
            .lowCardinalityKeyValue("rpc.service", "messenger.ChatAuthorization")
            .lowCardinalityKeyValue("rpc.method", "ValidateSessions")
            .observe<EntryPoint> { resolver.current() }
        assertEquals(EntryPoint("rpc", "messenger.ChatAuthorization/ValidateSessions"), resolved)
    }

    @Test
    fun `other observations fall back to the thread name instead of their free-form name`() {
        var resolved: EntryPoint? = null
        Thread({
            resolved = Observation.createNotStarted("custom.work", registry).contextualName("export-for-user-42")
                .observe<EntryPoint> { resolver.current() }
        }, "outbox-publication-7").apply {
            start()
            join()
        }
        assertEquals(EntryPoint("thread", "outbox-publication"), resolved)
    }

    @Test
    fun `work outside an observation falls back to the thread name without numbers`() {
        var resolved: EntryPoint? = null
        Thread({ resolved = resolver.current() }, "outbox-publisher-12").apply {
            start()
            join()
        }
        assertEquals(EntryPoint("thread", "outbox-publisher"), resolved)
    }

    fun scheduledJob() = Unit
}
