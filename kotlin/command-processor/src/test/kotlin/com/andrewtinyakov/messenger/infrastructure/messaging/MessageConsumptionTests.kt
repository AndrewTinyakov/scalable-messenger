package com.andrewtinyakov.messenger.infrastructure.messaging

import com.rabbitmq.client.Channel
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.slf4j.Logger
import org.springframework.amqp.core.Message
import org.springframework.amqp.core.MessageProperties
import org.springframework.dao.TransientDataAccessResourceException
import tools.jackson.databind.ObjectMapper
import java.io.IOException

class MessageConsumptionTests {
    private val metrics = SimpleMeterRegistry()
    private val channel = Mockito.mock(Channel::class.java)
    private val logger = Mockito.mock(Logger::class.java)
    private val tag = 42L
    private val message = Message(
        byteArrayOf(),
        MessageProperties().apply {
            deliveryTag = tag
            receivedRoutingKey = "message.send.v1"
        },
    )

    @Test
    fun `command kind metric labels retain their wire spelling`() {
        assertEquals("send", CommandKind.SEND.metricValue)
        assertEquals("dead_letter", CommandKind.DEAD_LETTER.metricValue)
    }

    @Test
    fun `successful message is acknowledged`() {
        var processed = false

        consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.SEND) {
            Mockito.verifyNoInteractions(channel)
            processed = true
        }

        assertTrue(processed)
        assertMetrics(outcome = CommandConsumptionOutcome.ACKNOWLEDGED, processingOutcome = CommandProcessingOutcome.ACKNOWLEDGED)
        Mockito.verify(channel).basicAck(tag, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `invalid message is rejected`() {
        consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.SEND) {
            throw IllegalArgumentException("Invalid object key")
        }

        assertMetrics(outcome = CommandConsumptionOutcome.PERMANENT_FAILURE, processingOutcome = CommandProcessingOutcome.FAILED)
        Mockito.verify(channel).basicReject(tag, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `malformed message is rejected`() {
        consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.SEND) {
            ObjectMapper().readTree("{")
        }

        assertMetrics(outcome = CommandConsumptionOutcome.PERMANENT_FAILURE, processingOutcome = CommandProcessingOutcome.FAILED)
        Mockito.verify(channel).basicReject(tag, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `temporary failure returns the message to the queue`() {
        consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.SEND) {
            throw TransientDataAccessResourceException("Database temporarily unavailable")
        }

        assertMetrics(outcome = CommandConsumptionOutcome.RETRY, processingOutcome = CommandProcessingOutcome.FAILED)
        Mockito.verify(channel).basicReject(tag, true)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `error leaves the message unacknowledged`() {
        val error = AssertionError("Processing failed")

        val thrown = assertThrows(AssertionError::class.java) {
            consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.SEND) {
                throw error
            }
        }

        assertSame(error, thrown)
        assertEquals(1L, metrics.get("messenger.command.processing").timer().count())
        Mockito.verifyNoInteractions(channel)
    }

    @Test
    fun `acknowledgement failure reaches the caller`() {
        val failure = IOException("Channel closed")
        Mockito.doThrow(failure).`when`(channel).basicAck(tag, false)

        val thrown = assertThrows(IOException::class.java) {
            consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.SEND) {}
        }

        assertSame(failure, thrown)
        assertEquals(null, metrics.find("messenger.command.consumed").counter())
        assertAcknowledgement("ack", "failure")
        assertEquals(1L, metrics.get("messenger.command.processing").tag("outcome", "failed").timer().count())
        Mockito.verify(channel).basicAck(tag, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `rejection failure reaches the caller`() {
        val failure = IOException("Channel closed")
        Mockito.doThrow(failure).`when`(channel).basicReject(tag, true)

        val thrown = assertThrows(IOException::class.java) {
            consumeMessage(message = message, channel = channel, logger = logger, metrics = metrics, kind = CommandKind.SEND) {
                throw TransientDataAccessResourceException("Database temporarily unavailable")
            }
        }

        assertSame(failure, thrown)
        assertEquals(
            1.0,
            metrics.get(
                "messenger.command.consumed",
            ).tags("kind", CommandKind.SEND.metricValue, "outcome", CommandConsumptionOutcome.RETRY.metricValue).counter().count(),
        )
        assertEquals(1L, metrics.get("messenger.command.processing").tag("outcome", "failed").timer().count())
        assertAcknowledgement("reject", "failure")
        Mockito.verify(channel).basicReject(tag, true)
        Mockito.verifyNoMoreInteractions(channel)
    }

    private fun assertAcknowledgement(operation: String, result: String) {
        assertEquals(
            1.0,
            metrics.get("messenger.command.acknowledgement")
                .tags("kind", "send", "operation", operation, "result", result).counter().count(),
        )
        assertEquals(1L, metrics.find("messenger.command.processing").timers().sumOf { it.count() })
    }

    private fun assertMetrics(outcome: CommandConsumptionOutcome, processingOutcome: CommandProcessingOutcome) {
        assertEquals(
            1.0,
            metrics.get(
                "messenger.command.consumed",
            ).tags("kind", CommandKind.SEND.metricValue, "outcome", outcome.metricValue).counter().count(),
        )
        assertEquals(
            1L,
            metrics.get(
                "messenger.command.processing",
            ).tags("kind", CommandKind.SEND.metricValue, "outcome", processingOutcome.metricValue).timer().count(),
        )
        assertAcknowledgement(if (outcome == CommandConsumptionOutcome.ACKNOWLEDGED) "ack" else "reject", "success")
        assertEquals(3, metrics.meters.size)
    }
}
