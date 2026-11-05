package com.andrewtinyakov.messenger.shared

import com.andrewtinyakov.messenger.ApiApplication
import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.TestInstance
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.testcontainers.containers.PostgreSQLContainer
import java.time.OffsetDateTime
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@SpringBootTest(
    classes = [ApiApplication::class],
    properties = [
        "messenger.read.notification-initial-delay-ms=3600000",
        "messenger.grpc.enabled=false",
        "spring.rabbitmq.dynamic=false",
        "spring.rabbitmq.listener.simple.auto-startup=false",
    ],
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
abstract class MessengerIntegrationTest {
    private lateinit var testExecutor: ExecutorService

    @Autowired
    protected lateinit var db: JdbcTemplate

    @BeforeEach
    fun startConcurrentTasks() {
        testExecutor = Executors.newVirtualThreadPerTaskExecutor()
    }

    @AfterEach
    fun stopConcurrentTasks() {
        testExecutor.shutdownNow()
        check(testExecutor.awaitTermination(10, TimeUnit.SECONDS)) { "Concurrent test tasks did not terminate" }
    }

    protected fun <T> concurrently(task: () -> T): CompletableFuture<T> = CompletableFuture.supplyAsync({ task() }, testExecutor)

    companion object {
        private val postgres = PostgreSQLContainer<Nothing>("postgres:17-alpine").apply {
            withDatabaseName("messenger")
            withUsername("messenger")
            withPassword("messenger")
            start()
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username", postgres::getUsername)
            registry.add("spring.datasource.password", postgres::getPassword)
        }
    }

    protected fun user(name: String): String = newId().also { id ->
        db.update("INSERT INTO users(id,username,password_hash) VALUES (?,?,'x')", id, name)
    }

    protected fun command(sender: String, request: String, body: String, chat: String? = null, recipient: String? = null) =
        SendMessageCommandV1(
            version = 1,
            chatId = chat,
            recipientId = recipient,
            requestId = request,
            senderId = sender,
            body = body,
            sentAt = OffsetDateTime.parse("2026-09-26T10:00:00Z"),
        )
}
