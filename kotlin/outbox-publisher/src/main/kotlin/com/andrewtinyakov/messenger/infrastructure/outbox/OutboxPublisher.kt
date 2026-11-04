package com.andrewtinyakov.messenger.infrastructure.outbox

import jakarta.annotation.PreDestroy
import org.postgresql.PGConnection
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import java.sql.Connection
import javax.sql.DataSource

@Component
class OutboxPublisher(
    private val dataSource: DataSource,
    private val outboxPublicationService: OutboxPublicationService,
    private val properties: PublisherProperties,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Volatile
    private var running = false

    private var worker: Thread? = null

    @EventListener(ApplicationReadyEvent::class)
    fun start() {
        running = true
        worker = Thread.ofPlatform().name("outbox-publisher").start { run() }
    }

    @PreDestroy
    fun stop() {
        running = false
        worker?.join(2000)
        if (worker?.isAlive == true) {
            worker?.interrupt()
            worker?.join(2000)
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
                        if (running) postgres.getNotifications(properties.pollMs)
                    }
                }
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            } catch (error: Exception) {
                if (!running) return
                log.error("Outbox publisher connection failed", error)
                try {
                    Thread.sleep(properties.pollMs.toLong())
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        }
    }

    private fun listen(connection: Connection) {
        connection.autoCommit = true
        connection.createStatement().use { it.execute("LISTEN messenger_outbox") }
    }
}
