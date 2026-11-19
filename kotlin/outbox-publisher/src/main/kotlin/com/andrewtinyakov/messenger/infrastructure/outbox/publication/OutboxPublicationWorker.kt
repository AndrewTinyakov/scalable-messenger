package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.OUTBOX_WAKEUP_CHANNEL
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublisherProperties
import jakarta.annotation.PreDestroy
import org.postgresql.PGConnection
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import java.sql.Connection

@Component
class OutboxPublicationWorker(
    private val listenConnections: OutboxListenConnections,
    private val outboxPublicationService: OutboxPublicationService,
    private val properties: OutboxPublisherProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Volatile
    private var state: OutboxWorkerState = OutboxWorkerState.Stopped

    private val running: Boolean
        get() = (state as? OutboxWorkerState.Running)?.thread === Thread.currentThread()

    @EventListener(ApplicationReadyEvent::class)
    @Synchronized
    fun start() {
        if (state != OutboxWorkerState.Stopped) return
        val thread = Thread.ofPlatform().name("outbox-publisher").unstarted {
            try {
                run()
            } finally {
                synchronized(this) { state = OutboxWorkerState.Stopped }
            }
        }
        state = OutboxWorkerState.Running(thread)
        try {
            thread.start()
        } catch (error: Throwable) {
            state = OutboxWorkerState.Stopped
            throw error
        }
    }

    @PreDestroy
    fun stop() {
        val thread = synchronized(this) {
            when (val current = state) {
                OutboxWorkerState.Stopped -> return
                is OutboxWorkerState.Running -> current.thread.also { state = OutboxWorkerState.Stopping(it) }
                is OutboxWorkerState.Stopping -> current.thread
            }
        }
        thread.join(properties.workerJoinTimeout)
        if (thread.isAlive) {
            thread.interrupt()
            thread.join(properties.workerJoinTimeout)
        }
    }

    private fun run() {
        while (running) {
            try {
                listenConnections.open().use { connection ->
                    listen(connection)
                    val postgres = connection.unwrap(PGConnection::class.java)
                    while (running) {
                        var published: Int
                        do {
                            postgres.getNotifications()
                            published = outboxPublicationService.publishBatch()
                        } while (running && published > 0)
                        if (running) postgres.getNotifications(properties.pollInterval.toMillis().toInt())
                    }
                }
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            } catch (error: Exception) {
                if (!running) return
                logger.error("Outbox publisher connection failed", error)
                try {
                    Thread.sleep(properties.pollInterval)
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        }
    }

    private fun listen(connection: Connection) {
        connection.autoCommit = true
        connection.createStatement().use { it.execute("LISTEN $OUTBOX_WAKEUP_CHANNEL") }
    }
}
