package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublisherProperties
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import org.postgresql.PGConnection
import org.postgresql.PGNotification
import java.sql.Connection
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.sql.DataSource

class OutboxPublicationWorkerTests {
    @Test
    fun `a timed out stop retains its worker until it exits`() {
        val dataSource = mock(DataSource::class.java)
        val connection = mock(Connection::class.java)
        val statement = mock(java.sql.Statement::class.java)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        `when`(dataSource.connection).thenAnswer {
            entered.countDown()
            while (release.count > 0) {
                try {
                    release.await()
                } catch (_: InterruptedException) {
                    continue
                }
            }
            connection
        }
        `when`(connection.createStatement()).thenReturn(statement)
        `when`(connection.unwrap(PGConnection::class.java)).thenReturn(mock(PGConnection::class.java))
        val publisher = OutboxPublicationWorker(
            dataSource,
            mock(OutboxPublicationService::class.java),
            OutboxPublisherProperties(workerJoinTimeout = Duration.ofMillis(10)),
        )
        publisher.start()
        try {
            assertTrue(entered.await(1, TimeUnit.SECONDS))
            publisher.stop()
            publisher.start()
            verify(dataSource, times(1)).connection
        } finally {
            release.countDown()
            publisher.stop()
        }
        verify(connection).close()
    }

    @Test
    fun `repeated readiness events keep one worker and stop allows a fresh worker`() {
        val dataSource = mock(DataSource::class.java)
        val connection = mock(Connection::class.java)
        val postgres = mock(PGConnection::class.java)
        val statement = mock(java.sql.Statement::class.java)
        val publication = mock(OutboxPublicationService::class.java)
        val connections = AtomicInteger()
        val connected = CountDownLatch(1)
        val duplicateConnection = CountDownLatch(1)
        val release = CountDownLatch(1)
        `when`(dataSource.connection).thenAnswer {
            if (connections.incrementAndGet() == 1) connected.countDown() else duplicateConnection.countDown()
            connection
        }
        `when`(connection.createStatement()).thenReturn(statement)
        `when`(connection.unwrap(PGConnection::class.java)).thenReturn(postgres)
        `when`(postgres.getNotifications(100)).thenAnswer {
            check(release.await(5, TimeUnit.SECONDS))
            emptyArray<PGNotification>()
        }
        val publisher = OutboxPublicationWorker(dataSource, publication, OutboxPublisherProperties(pollInterval = Duration.ofMillis(100)))
        publisher.start()
        try {
            assertTrue(connected.await(1, TimeUnit.SECONDS))
            publisher.start()
            assertFalse(duplicateConnection.await(100, TimeUnit.MILLISECONDS))
        } finally {
            release.countDown()
            publisher.stop()
        }
        publisher.stop()
        assertEquals(1, connections.get())
        publisher.start()
        try {
            assertTrue(duplicateConnection.await(1, TimeUnit.SECONDS))
        } finally {
            publisher.stop()
        }
        assertEquals(2, connections.get())
    }

    @Test
    fun `notification arriving during an empty claim wakes the next query`() {
        val dataSource = mock(DataSource::class.java)
        val connection = mock(Connection::class.java)
        val postgres = mock(PGConnection::class.java)
        val statement = mock(java.sql.Statement::class.java)
        val publication = mock(OutboxPublicationService::class.java)
        val notification = AtomicBoolean(false)
        val calls = AtomicInteger()
        val nextQuery = CountDownLatch(1)
        val release = CountDownLatch(1)
        `when`(dataSource.connection).thenReturn(connection)
        `when`(connection.createStatement()).thenReturn(statement)
        `when`(connection.unwrap(PGConnection::class.java)).thenReturn(postgres)
        `when`(postgres.notifications).thenAnswer {
            notification.set(false)
            emptyArray<PGNotification>()
        }
        `when`(postgres.getNotifications(5000)).thenAnswer {
            if (!notification.getAndSet(false)) check(release.await(5, TimeUnit.SECONDS))
            emptyArray<PGNotification>()
        }
        `when`(publication.publishBatch()).thenAnswer {
            if (calls.getAndIncrement() == 0) notification.set(true) else nextQuery.countDown()
            0
        }
        val publisher = OutboxPublicationWorker(dataSource, publication, OutboxPublisherProperties(pollInterval = Duration.ofSeconds(5)))
        publisher.start()
        try {
            assertTrue(nextQuery.await(1, TimeUnit.SECONDS))
        } finally {
            release.countDown()
            publisher.stop()
        }
    }
}
