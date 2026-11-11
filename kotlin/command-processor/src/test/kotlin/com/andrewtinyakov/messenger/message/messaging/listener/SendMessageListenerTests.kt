package com.andrewtinyakov.messenger.message.messaging.listener

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.infrastructure.messaging.monitoring.CommandMetrics
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.monitoring.MessageSendMetrics
import com.andrewtinyakov.messenger.message.service.MessageSendBatchService
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.id.newId
import com.rabbitmq.client.Channel
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.amqp.core.Message
import org.springframework.amqp.core.MessageProperties
import org.springframework.dao.TransientDataAccessResourceException
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.AbstractPlatformTransactionManager
import org.springframework.transaction.support.DefaultTransactionStatus
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.module.kotlin.jacksonObjectMapper
import java.io.IOException
import java.time.OffsetDateTime
import java.time.ZoneOffset

class SendMessageListenerTests {
    private val service = Mockito.mock(MessageSendService::class.java)
    private val channel = Mockito.mock(Channel::class.java)
    private val mapper = jacksonObjectMapper()
    private val metrics = SimpleMeterRegistry()
    private val transactions = RecordingTransactions()
    private val batches = MessageSendBatchService(service, TransactionTemplate(transactions), MessageSendMetrics(metrics))
    private val listener = SendMessageListener(service, batches, CommandMetrics(metrics), mapper)
    private val sender = newId()
    private val chat = newId()

    @Test
    fun `acknowledgements happen after one shared commit`() {
        val commands = listOf(command(), command())
        Mockito.`when`(service.processBatchInTransaction(commands)).thenAnswer {
            assertEquals(0.0, metrics.get("messenger.command.result").tag("result", "saved").counter().count())
            List(2) { CommandResult.SAVED }
        }
        Mockito.doAnswer {
            assertEquals(1, transactions.commits)
            assertEquals(2.0, metrics.get("messenger.command.result").tag("result", "saved").counter().count())
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive())
            null
        }.`when`(channel).basicAck(Mockito.anyLong(), Mockito.eq(false))

        listener.onSendCommand(commands.mapIndexed { index, command -> message(command, index + 1L) }, channel)

        assertEquals(1, transactions.commits)
        assertEquals(0, transactions.rollbacks)
        assertEquals(1L, metrics.get("messenger.send.batch.transaction").tag("outcome", "committed").timer().count())
        assertEquals(2.0, metrics.get("messenger.send.batch.size").tag("outcome", "committed").summary().totalAmount())
        Mockito.verify(channel).basicAck(1L, false)
        Mockito.verify(channel).basicAck(2L, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `malformed identity and JSON cannot poison valid peers`() {
        val valid = command()
        Mockito.`when`(service.processBatchInTransaction(listOf(valid))).thenReturn(listOf(CommandResult.SAVED))
        val invalid = command().copy(senderId = "invalid")
        val malformed = Message("{".toByteArray(), MessageProperties().apply { deliveryTag = 3L })

        listener.onSendCommand(listOf(message(invalid, 1L), message(valid, 2L), malformed), channel)

        assertEquals(1, transactions.commits)
        Mockito.verify(service).processBatchInTransaction(listOf(valid))
        Mockito.verifyNoMoreInteractions(service)
        Mockito.verify(channel).basicReject(1L, false)
        Mockito.verify(channel).basicAck(2L, false)
        Mockito.verify(channel).basicReject(3L, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `failed shared transaction falls back so a valid peer commits`() {
        val valid = command()
        val failing = command()
        Mockito.`when`(
            service.processBatchInTransaction(listOf(valid, failing)),
        ).thenThrow(TransientDataAccessResourceException("unavailable"))
        Mockito.`when`(service.processBatchInTransaction(listOf(valid))).thenReturn(listOf(CommandResult.SAVED))
        Mockito.`when`(service.processBatchInTransaction(listOf(failing))).thenThrow(TransientDataAccessResourceException("unavailable"))

        listener.onSendCommand(listOf(message(valid, 1L), message(failing, 2L)), channel)

        assertEquals(1, transactions.commits)
        assertEquals(2, transactions.rollbacks)
        assertEquals(1.0, metrics.get("messenger.command.result").tag("result", "saved").counter().count())
        assertEquals(2L, metrics.get("messenger.send.batch.transaction").tag("outcome", "rolled_back").timer().count())
        Mockito.verify(service).processBatchInTransaction(listOf(valid, failing))
        Mockito.verify(service).processBatchInTransaction(listOf(valid))
        Mockito.verify(service).processBatchInTransaction(listOf(failing))
        Mockito.verify(channel).basicAck(1L, false)
        Mockito.verify(channel).basicReject(2L, true)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `acknowledgement failure propagates without replaying the committed batch`() {
        val first = command()
        val second = command()
        Mockito.`when`(service.processBatchInTransaction(listOf(first, second))).thenReturn(List(2) { CommandResult.SAVED })
        val failure = IOException("channel closed")
        Mockito.doThrow(failure).`when`(channel).basicAck(1L, false)

        assertSame(
            failure,
            assertThrows(IOException::class.java) {
                listener.onSendCommand(listOf(message(first, 1L), message(second, 2L)), channel)
            },
        )

        assertEquals(1, transactions.commits)
        assertEquals(0, transactions.rollbacks)
        assertEquals(2.0, metrics.get("messenger.command.result").tag("result", "saved").counter().count())
        Mockito.verify(service).processBatchInTransaction(listOf(first, second))
        Mockito.verifyNoMoreInteractions(service)
        Mockito.verify(channel).basicAck(1L, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `commit failure cannot count a successful command result`() {
        val command = command()
        Mockito.`when`(service.processBatchInTransaction(listOf(command))).thenReturn(listOf(CommandResult.SAVED))
        transactions.commitFailure = TransientDataAccessResourceException("commit failed")

        listener.onSendCommand(listOf(message(command, 1L)), channel)

        assertEquals(0, transactions.commits)
        assertEquals(0.0, metrics.get("messenger.command.result").tag("result", "saved").counter().count())
        assertEquals(1, transactions.rollbacks)
        assertEquals(1L, metrics.get("messenger.send.batch.transaction").tag("outcome", "rolled_back").timer().count())
        Mockito.verify(channel).basicReject(1L, true)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `producer batch delivery tag is rejected once`() {
        listener.onSendCommand(listOf(message(command(), 1L), message(command(), 1L)), channel)

        assertEquals(0, transactions.commits)
        Mockito.verifyNoInteractions(service)
        Mockito.verify(channel).basicReject(1L, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `oversized command is rejected before decoding`() {
        val oversized = Message(ByteArray(SendMessageListener.MAX_COMMAND_BYTES + 1), MessageProperties().apply { deliveryTag = 1L })

        listener.onSendCommand(listOf(oversized), channel)

        Mockito.verifyNoInteractions(service)
        Mockito.verify(channel).basicReject(1L, false)
        Mockito.verifyNoMoreInteractions(channel)
    }

    @Test
    fun `batch processing retains arrival order inside the transaction`() {
        val first = command().copy(requestId = "00000000000000000000000001")
        val second = command().copy(requestId = "00000000000000000000000002")
        Mockito.`when`(service.processBatchInTransaction(listOf(second, first))).thenAnswer {
            assertTrue(TransactionSynchronizationManager.isActualTransactionActive())
            listOf(CommandResult.SAVED, CommandResult.SAVED)
        }

        listener.onSendCommand(listOf(message(second, 1L), message(first, 2L)), channel)

        Mockito.verify(service).processBatchInTransaction(listOf(second, first))
        Mockito.verifyNoMoreInteractions(service)
    }

    private fun command() = SendMessageCommandV1.create(
        chatId = chat,
        requestId = newId(),
        senderId = sender,
        body = "hello",
        sentAt = OffsetDateTime.now(ZoneOffset.UTC),
    )

    private fun message(command: SendMessageCommandV1, tag: Long) = Message(
        mapper.writeValueAsBytes(command),
        MessageProperties().apply { deliveryTag = tag },
    )

    private class RecordingTransactions : AbstractPlatformTransactionManager() {
        var commits = 0
        var rollbacks = 0
        var commitFailure: RuntimeException? = null

        override fun doGetTransaction(): Any = Any()

        override fun doBegin(transaction: Any, definition: TransactionDefinition) {}

        override fun doCommit(status: DefaultTransactionStatus) {
            commitFailure?.let { throw it }
            commits++
        }

        override fun doRollback(status: DefaultTransactionStatus) {
            rollbacks++
        }
    }
}
