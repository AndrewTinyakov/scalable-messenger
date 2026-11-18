package com.andrewtinyakov.messenger.infrastructure.grpc

import com.andrewtinyakov.messenger.ws.grpc.ChatAuthorizationGrpcService
import io.grpc.ServerServiceDefinition
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import java.io.File

class GrpcServerLifecycleTests {
    @Test
    fun `start and stop are idempotent and a stopped server can restart`() {
        val service = mock(ChatAuthorizationGrpcService::class.java)
        `when`(service.bindService()).thenReturn(ServerServiceDefinition.builder("messenger.ChatAuthorization").build())
        val server = GrpcServerLifecycle(
            service,
            GrpcProperties(
                port = 0,
                bindAddress = "127.0.0.1",
                caFile = fixture("ca.pem").path,
                certFile = fixture("api-cert.pem").path,
                keyFile = fixture("api-key.pem").path,
                allowedClientIdentity = "spiffe://messenger/ws",
            ),
        )
        assertFalse(server.isRunning)
        assertThrows(IllegalStateException::class.java) { server.boundPort }
        repeat(2) {
            server.start()
            try {
                assertTrue(server.isRunning)
                val port = server.boundPort
                assertTrue(port > 0)
                server.start()
                assertEquals(port, server.boundPort)
            } finally {
                server.stop()
            }
            assertFalse(server.isRunning)
            server.stop()
        }
    }

    private fun fixture(name: String): File = File(requireNotNull(javaClass.getResource("/grpc-tls/$name")).toURI())
}
