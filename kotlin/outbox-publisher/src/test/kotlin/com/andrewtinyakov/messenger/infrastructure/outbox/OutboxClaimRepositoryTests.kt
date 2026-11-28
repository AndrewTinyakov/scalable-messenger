package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.MessengerOutboxPublisherApplication
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.outbox.publication.OutboxPublicationWorker
import com.andrewtinyakov.messenger.shared.id.newId
import org.jooq.DSLContext
import org.jooq.JSONB
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.GenericContainer
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import java.time.Instant
import java.time.OffsetDateTime
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@Testcontainers
@SpringBootTest(classes = [MessengerOutboxPublisherApplication::class])
class OutboxClaimRepositoryTests {
    @MockitoBean private lateinit var worker: OutboxPublicationWorker

    @Autowired private lateinit var outboxRepository: OutboxRepository

    @Autowired private lateinit var claimRepository: OutboxClaimRepository

    @Autowired private lateinit var tx: TransactionTemplate

    @Autowired private lateinit var db: DSLContext

    private val executor = Executors.newVirtualThreadPerTaskExecutor()

    @AfterEach
    fun stopConcurrentTasks() {
        executor.shutdownNow()
        check(executor.awaitTermination(10, TimeUnit.SECONDS)) { "Concurrent test tasks did not terminate" }
    }

    private fun <T> concurrently(task: () -> T): CompletableFuture<T> = CompletableFuture.supplyAsync({ task() }, executor)

    @Test
    fun `expired group prefixes transfer ownership without changing publication order`() {
        val room = "group:${newId()}"
        val ids = List(3) { EventId(newId()) }
        outboxRepository.enqueue(ids.map { OutboxMessage(it, room, "{}") })
        ids.forEach {
            db.update(MESSENGER_OUTBOX_EVENTS).set(MESSENGER_OUTBOX_EVENTS.CREATED_AT, OffsetDateTime.parse("1970-01-01T00:00:00Z"))
                .where(MESSENGER_OUTBOX_EVENTS.ID.eq(it.value)).execute()
        }
        val now = OffsetDateTime.now()
        val anchor = tx.execute { claimRepository.claim(now, 1000, "expired-a", now.plusSeconds(30)) }.single { it.room == room }
        val tail = tx.execute { claimRepository.claimGroupTail(anchor, now, 2, "expired-a", now.plusSeconds(30)) }
        val future = now.plusSeconds(31)
        val replacement = tx.execute { claimRepository.claim(future, 1000, "expired-b", future.plusSeconds(30)) }.single {
            it.room ==
                room
        }
        val replacementTail = tx.execute {
            claimRepository.claimGroupTail(replacement, future, 2, "expired-b", future.plusSeconds(30))
        }
        assertEquals(listOf(anchor) + tail, listOf(replacement) + replacementTail)
        assertEquals(
            emptyList<OutboxMessage>(),
            tx.execute {
                claimRepository.claimGroupTail(anchor, future, 2, "expired-a", future.plusSeconds(30))
            },
        )
        assertThrows(IllegalStateException::class.java) { claimRepository.complete(ids, "expired-a") }
        claimRepository.complete(ids, "expired-b")
    }

    @Test
    fun `group prefix stops before an unavailable earlier event`() {
        val room = "group:${newId()}"
        val ids = List(3) { EventId(newId()) }
        outboxRepository.enqueue(ids.map { OutboxMessage(it, room, "{}") })
        val now = OffsetDateTime.now()
        val lease = now.plusSeconds(30)
        val anchor = tx.execute { claimRepository.claim(now, 1000, "barrier-a", lease) }.single { it.room == room }
        db.update(MESSENGER_OUTBOX_EVENTS)
            .set(MESSENGER_OUTBOX_EVENTS.LEASE_OWNER, "barrier-b")
            .set(MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL, lease)
            .where(MESSENGER_OUTBOX_EVENTS.ID.eq(ids[1].value)).execute()
        assertEquals(emptyList<OutboxMessage>(), tx.execute { claimRepository.claimGroupTail(anchor, now, 10, "barrier-a", lease) })
        claimRepository.complete(listOf(ids[0]), "barrier-a")
        claimRepository.complete(listOf(ids[1]), "barrier-b")
        val last = tx.execute { claimRepository.claim(now, 1000, "barrier-a", lease) }.single { it.room == room }
        assertEquals(ids[2], last.id)
        claimRepository.complete(listOf(last.id), "barrier-a")
    }

    @Test
    fun `group tail claims are bounded and cannot overtake another publisher`() {
        val room = "group:${newId()}"
        val ids = List(5) { EventId(newId()) }
        outboxRepository.enqueue(ids.map { OutboxMessage(it, room, "{}") })
        ids.forEach {
            db.update(MESSENGER_OUTBOX_EVENTS).set(MESSENGER_OUTBOX_EVENTS.CREATED_AT, OffsetDateTime.parse("1980-01-01T00:00:00Z"))
                .where(MESSENGER_OUTBOX_EVENTS.ID.eq(it.value)).execute()
        }
        val now = OffsetDateTime.now()
        val lease = now.plusSeconds(30)
        val anchor = tx.execute { claimRepository.claim(now, 1000, "prefix-a", lease) }.single { it.room == room }
        val tail = tx.execute { claimRepository.claimGroupTail(anchor, now, 2, "prefix-a", lease) }
        assertEquals(
            List(3) { Instant.parse("1980-01-01T00:00:00Z") },
            (listOf(anchor) + tail).map { it.createdAt?.toInstant() },
        )
        assertEquals(ids.subList(1, 3), tail.map { it.id })
        assertTrue(tail.all { it.groupPublicationOrder!! > anchor.groupPublicationOrder!! })
        assertEquals(emptyList<OutboxMessage>(), tx.execute { claimRepository.claimGroupTail(anchor, now, 2, "prefix-b", lease) })
        claimRepository.complete(listOf(anchor.id), "prefix-a")
        assertEquals(
            emptyList<OutboxMessage>(),
            tx.execute { claimRepository.claim(now, 1000, "prefix-b", lease) }.filter {
                it.room ==
                    room
            },
        )
        claimRepository.complete(tail.map { it.id }, "prefix-a")
        val next = tx.execute { claimRepository.claim(now, 1000, "prefix-b", lease) }.single { it.room == room }
        assertEquals(ids[3], next.id)
        claimRepository.complete(listOf(next.id), "prefix-b")
        val last = tx.execute { claimRepository.claim(now, 1000, "prefix-b", lease) }.single { it.room == room }
        assertEquals(ids[4], last.id)
        claimRepository.complete(listOf(last.id), "prefix-b")
    }

    @Test
    fun `concurrent publishers skip locked events and claim distinct ordered work`() {
        val room = "user:${newId()}"
        val ids = List(3) { EventId(newId()) }.sortedBy { it.value }
        outboxRepository.enqueue(messages = ids.map { OutboxMessage(id = it, room = room, payload = "{}") })
        ids.forEach {
            db.update(MESSENGER_OUTBOX_EVENTS).set(MESSENGER_OUTBOX_EVENTS.CREATED_AT, OffsetDateTime.parse("1990-01-01T00:00:00Z"))
                .where(MESSENGER_OUTBOX_EVENTS.ID.eq(it.value)).execute()
        }
        val now = OffsetDateTime.now()
        val locked = CountDownLatch(1)
        val release = CountDownLatch(1)
        val first = concurrently {
            tx.execute {
                val claimed = claimRepository.claim(now = now, limit = 1, owner = "claim-first", leaseUntil = now.plusSeconds(30))
                locked.countDown()
                check(release.await(10, TimeUnit.SECONDS))
                claimed
            }
        }

        try {
            assertTrue(locked.await(10, TimeUnit.SECONDS))
            val second = concurrently {
                tx.execute {
                    claimRepository.claim(now = now, limit = 2, owner = "claim-second", leaseUntil = now.plusSeconds(30))
                }
            }.get(5, TimeUnit.SECONDS)

            assertEquals(ids.drop(1), second.map { it.id })
            claimRepository.complete(ids = second.map { it.id }, owner = "claim-second")
        } finally {
            release.countDown()
        }
        assertEquals(ids.take(1), first.get(5, TimeUnit.SECONDS).map { it.id })
        claimRepository.complete(ids = ids.take(1), owner = "claim-first")
    }

    @Test
    fun `outbox completion deletes only rows leased by this publisher`() {
        val owned = newId()
        val other = newId()
        val payload = JSONB.valueOf("{}")
        db.insertInto(
            MESSENGER_OUTBOX_EVENTS,
            MESSENGER_OUTBOX_EVENTS.ID,
            MESSENGER_OUTBOX_EVENTS.ROOM,
            MESSENGER_OUTBOX_EVENTS.PAYLOAD,
            MESSENGER_OUTBOX_EVENTS.LEASE_OWNER,
        ).values(owned, "user:test", payload, "publisher-a")
            .values(other, "user:test", payload, "publisher-b")
            .execute()

        claimRepository.complete(listOf(EventId(owned)), "publisher-a")

        assertEquals(0, db.fetchCount(MESSENGER_OUTBOX_EVENTS, MESSENGER_OUTBOX_EVENTS.ID.eq(owned)))
        assertEquals(1, db.fetchCount(MESSENGER_OUTBOX_EVENTS, MESSENGER_OUTBOX_EVENTS.ID.eq(other)))
    }

    @Test
    fun `group room events wait for earlier publication across publisher claims`() {
        val room = "group:${newId()}"
        val ids = listOf(newId(), newId()).sortedDescending()
        outboxRepository.enqueue(
            listOf(
                OutboxMessage(EventId(ids[0]), room, """{"type":"member_removed"}"""),
                OutboxMessage(EventId(ids[1]), room, """{"type":"message_saved"}"""),
            ),
        )
        ids.forEach {
            db.update(MESSENGER_OUTBOX_EVENTS).set(MESSENGER_OUTBOX_EVENTS.CREATED_AT, OffsetDateTime.parse("1989-01-01T00:00:00Z"))
                .where(MESSENGER_OUTBOX_EVENTS.ID.eq(it)).execute()
        }
        val now = OffsetDateTime.now()

        val firstClaim = tx.execute { claimRepository.claim(now, 1000, "group-order-first", now.plusSeconds(30)) }
        assertEquals(listOf(EventId(ids[0])), firstClaim.filter { it.room == room }.map { it.id })

        val blockedClaim = tx.execute { claimRepository.claim(now, 1000, "group-order-second", now.plusSeconds(30)) }
        assertEquals(emptyList<String>(), blockedClaim.filter { it.room == room }.map { it.id })

        claimRepository.complete(listOf(EventId(ids[0])), "group-order-first")
        val secondClaim = tx.execute { claimRepository.claim(now, 1000, "group-order-second", now.plusSeconds(30)) }
        assertEquals(listOf(EventId(ids[1])), secondClaim.filter { it.room == room }.map { it.id })
        claimRepository.complete(listOf(EventId(ids[1])), "group-order-second")
    }

    companion object {
        @Container @JvmField
        val postgres = PostgreSQLContainer("postgres:19-alpine")

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
