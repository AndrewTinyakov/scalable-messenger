package com.andrewtinyakov.messenger.infrastructure.monitoring

import jdk.jfr.Recording
import jdk.jfr.consumer.RecordingFile
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files

class SendStageRecorderTests {
    @Test
    fun `disabled recording skips request and receipt iteration`() {
        assertFalse(SendStageRecorder.isEnabled)
        val requests = Iterable<String> { error("Disabled recording must not visit requests") }

        SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = "request-1", eventId = "event-1")
        SendStageRecorder.requests(SendStage.REQUEST_LOCKS_ACQUIRED, requests) { it }
        assertTrue(SendStageRecorder.beginEach(SendStage.LISTENER_RECEIVED, requests) { it }.isEmpty())
    }

    @Test
    fun `enabled recording preserves stage identities without payloads or stack traces`() {
        val path = Files.createTempFile("messenger-send-stages-", ".jfr")
        try {
            Recording().use { recording ->
                recording.enable("messenger.SendStage")
                recording.start()
                assertTrue(SendStageRecorder.isEnabled)
                val received = SendStageRecorder.beginEach(SendStage.LISTENER_RECEIVED, listOf("request-1")) { it }
                SendStageRecorder.record(SendStage.EVENT_PREPARED, requestId = "request-1", eventId = "event-1")
                SendStageRecorder.requests(SendStage.REQUEST_LOCKS_ACQUIRED, listOf("request-1", "request-2")) { it }
                SendStageRecorder.record(SendStage.REDIS_PUBLISH_CONFIRMED, eventId = "event-1")
                SendStageRecorder.commit(received["request-1"], "request-1")
                assertDoesNotThrow {
                    SendStageRecorder.requests(SendStage.RESULTS_LOOKED_UP, listOf("request-1")) { error("Probe failed") }
                }
                assertThrows(InternalError::class.java) {
                    SendStageRecorder.requests(SendStage.RESULTS_LOOKED_UP, listOf("request-1")) { throw InternalError("Fatal") }
                }
                recording.stop()
                recording.dump(path)
            }

            val events = RecordingFile.readAllEvents(path).filter { it.eventType.name == "messenger.SendStage" }
            assertEquals(5, events.size)
            val prepared = events.single { it.getString("stage") == "event_prepared" }
            assertEquals("request-1", prepared.getString("requestId"))
            assertEquals("event-1", prepared.getString("eventId"))
            val received = events.single { it.getString("stage") == "listener_received" }
            assertEquals("request-1", received.getString("requestId"))
            assertTrue(received.startTime <= prepared.startTime)
            val published = events.single { it.getString("stage") == "redis_publish_confirmed" }
            assertNull(published.getString("requestId"))
            assertEquals("event-1", published.getString("eventId"))
            assertEquals(
                setOf("request-1", "request-2"),
                events.filter { it.getString("stage") == "request_locks_acquired" }.map { it.getString("requestId") }.toSet(),
            )
            val builtInFields = setOf("startTime", "duration", "eventThread", "stackTrace")
            events.forEach { event ->
                assertEquals(setOf("stage", "requestId", "eventId"), event.eventType.fields.map { it.name }.toSet() - builtInFields)
                assertNull(event.stackTrace)
            }
            assertFalse(SendStageRecorder.isEnabled)
        } finally {
            Files.deleteIfExists(path)
        }
    }
}
