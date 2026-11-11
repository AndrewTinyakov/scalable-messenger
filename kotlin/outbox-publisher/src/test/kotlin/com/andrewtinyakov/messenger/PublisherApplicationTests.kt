package com.andrewtinyakov.messenger

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxBacklog
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublicationService
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers

@Testcontainers
@SpringBootTest(classes = [MessengerOutboxPublisherApplication::class], webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PublisherApplicationTests {
    @Autowired private lateinit var publication: OutboxPublicationService

    @Autowired private lateinit var messages: MessageRepository

    @Autowired private lateinit var outbox: OutboxRepository

    @Test
    fun `publisher starts with its real hydration persistence adapter`() {
        assertNotNull(messages)
        assertEquals(0, publication.publishBatch())
    }

    @Test
    fun `backlog sample reads the real outbox table`() {
        assertEquals(OutboxBacklog(pending = 0, oldestCreatedAt = null), outbox.backlog())
    }

    companion object {
        @Container @JvmField
        val postgres = PostgreSQLContainer("postgres:17-alpine")

        @Container @JvmField
        val redis = GenericContainer("redis:7.4-alpine").withExposedPorts(6379)

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username", postgres::getUsername)
            registry.add("spring.datasource.password", postgres::getPassword)
            registry.add("spring.data.redis.host", redis::getHost)
            registry.add("spring.data.redis.port") { redis.getMappedPort(6379) }
        }
    }
}
