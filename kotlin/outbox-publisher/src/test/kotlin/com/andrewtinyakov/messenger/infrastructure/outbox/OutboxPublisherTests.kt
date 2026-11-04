package com.andrewtinyakov.messenger.infrastructure.outbox

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import org.postgresql.PGConnection
import org.postgresql.PGNotification
import java.sql.Connection
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.sql.DataSource

class OutboxPublisherTests {
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
        val publisher = OutboxPublisher(dataSource, publication, PublisherProperties(pollMs = 5000))
        publisher.start()
        try {
            assertTrue(nextQuery.await(1, TimeUnit.SECONDS))
        } finally {
            release.countDown()
            publisher.stop()
        }
    }
}
