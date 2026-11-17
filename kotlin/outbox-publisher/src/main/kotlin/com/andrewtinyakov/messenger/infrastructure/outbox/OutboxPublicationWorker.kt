package com.andrewtinyakov.messenger.infrastructure.outbox

import jakarta.annotation.PreDestroy
import org.postgresql.PGConnection
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import java.sql.Connection
import javax.sql.DataSource

private const val NOTIFICATION_CHANNEL = "messenger_outbox"

@Component
class OutboxPublicationWorker(
    private val dataSource: DataSource,
    private val outboxPublicationService: OutboxPublicationService,
    private val properties: PublisherProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Volatile
    private var state: WorkerState = WorkerState.Stopped

    private val running: Boolean
        get() = (state as? WorkerState.Running)?.thread === Thread.currentThread()

    @EventListener(ApplicationReadyEvent::class)
    @Synchronized
    fun start() {
        if (state != WorkerState.Stopped) return
        val thread = Thread.ofPlatform().name("outbox-publisher").unstarted {
            try {
                run()
            } finally {
                synchronized(this) { state = WorkerState.Stopped }
            }
        }
        state = WorkerState.Running(thread)
        try {
            thread.start()
        } catch (error: Throwable) {
            state = WorkerState.Stopped
            throw error
        }
    }

    @PreDestroy
    fun stop() {
        val thread = synchronized(this) {
            when (val current = state) {
                WorkerState.Stopped -> return
                is WorkerState.Running -> current.thread.also { state = WorkerState.Stopping(it) }
                is WorkerState.Stopping -> current.thread
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
                dataSource.connection.use { connection ->
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

    private sealed interface WorkerState {
        data object Stopped : WorkerState

        data class Running(
            val thread: Thread,
        ) : WorkerState

        data class Stopping(
            val thread: Thread,
        ) : WorkerState
    }

    private fun listen(connection: Connection) {
        connection.autoCommit = true
        connection.createStatement().use { it.execute("LISTEN $NOTIFICATION_CHANNEL") }
    }
}
